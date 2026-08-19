import fs from "node:fs/promises";
import { watch } from "node:fs";
import { createClaudeParser } from "./claude.js";
import { createCodexParser } from "./codex.js";
import { recordConfirmsRabbitholeSession } from "./confirmation.js";
import { AgentCorrelator } from "./correlation.js";
import { unavailableContextUsage } from "./usage.js";

const DEFAULT_POLL_MS = 1500;
const DEFAULT_THROTTLE_MS = 2000;

function sameUsage(left, right) {
  return left?.quality === right?.quality && left?.agent === right?.agent && left?.model === right?.model &&
    left?.used_tokens === right?.used_tokens && left?.window_tokens === right?.window_tokens &&
    left?.percent === right?.percent && left?.measured_at === right?.measured_at;
}

function parserFor(agent, now) {
  return agent === "claude" ? createClaudeParser({ now }) : createCodexParser({ now });
}

async function readRange(filePath, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return Buffer.alloc(0);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset === length ? buffer : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export class AgentContextMonitor {
  constructor({
    correlate = null,
    pollMs = DEFAULT_POLL_MS,
    throttleMs = DEFAULT_THROTTLE_MS,
    now = () => new Date(),
  } = {}) {
    const correlator = correlate ? null : new AgentCorrelator();
    this.correlate = correlate || ((options) => correlator.discover(options));
    this.pollMs = pollMs;
    this.throttleMs = throttleMs;
    this.now = now;
    this.listeners = new Map();
    this.current = unavailableContextUsage();
    this.pending = null;
    this.correlation = null;
    this.parser = null;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.fileIdentity = null;
    this.fileMtimeMs = 0;
    this.watcher = null;
    this.pollTimer = null;
    this.emitTimer = null;
    this.lastEmittedAt = 0;
    this.lastValidationAt = 0;
    this.refreshing = false;
    this.refreshAgain = false;
    this.active = false;
    this.confirmed = false;
  }

  get running() { return this.active; }

  subscribe(listener, { sessionId = null } = {}) {
    const key = Symbol("context-listener");
    this.listeners.set(key, { listener, sessionId });
    listener(this.current);
    if (!this.active) this.start();
    return () => {
      this.listeners.delete(key);
      if (this.listeners.size === 0) this.stop();
    };
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.pollTimer = setInterval(() => this.requestRefresh(), this.pollMs);
    this.pollTimer.unref?.();
    this.requestRefresh();
  }

  stop() {
    this.active = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.pollTimer = null;
    this.emitTimer = null;
    this.pending = null;
    this.closeWatcher();
    this.resetTail();
    this.current = unavailableContextUsage();
    this.lastEmittedAt = 0;
  }

  sessionIds() {
    return new Set([...this.listeners.values()].map((entry) => entry.sessionId).filter(Boolean));
  }

  requestRefresh() {
    if (!this.active) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    void this.refreshLoop();
  }

  async refreshLoop() {
    try {
      do {
        this.refreshAgain = false;
        await this.refresh();
      } while (this.active && this.refreshAgain);
    } catch {
      if (this.active) this.loseCorrelation();
    } finally {
      this.refreshing = false;
    }
  }

  async refresh() {
    if (!this.correlation) {
      const correlation = await this.correlate({ startPid: process.ppid, sessionIds: this.sessionIds() });
      if (!this.active) return;
      if (!correlation || (correlation.agent !== "claude" && correlation.agent !== "codex") || !correlation.transcriptPath) {
        this.setState(unavailableContextUsage());
        return;
      }
      await this.attach(correlation);
      return;
    }

    const validationInterval = this.correlation.validationIntervalMs ?? 10_000;
    if (typeof this.correlation.validate === "function" && Date.now() - this.lastValidationAt >= validationInterval) {
      this.lastValidationAt = Date.now();
      if (!await this.correlation.validate()) {
        this.loseCorrelation();
        this.refreshAgain = true;
        return;
      }
    }

    let stat;
    try { stat = await fs.stat(this.correlation.transcriptPath); }
    catch {
      this.loseCorrelation();
      this.refreshAgain = true;
      return;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (identity !== this.fileIdentity || stat.size < this.offset || (stat.size === this.offset && stat.mtimeMs !== this.fileMtimeMs)) {
      this.loseCorrelation();
      this.refreshAgain = true;
      return;
    }
    if (stat.size > this.offset) {
      const bytes = await readRange(this.correlation.transcriptPath, this.offset, stat.size);
      this.offset += bytes.length;
      this.fileMtimeMs = stat.mtimeMs;
      this.consume(bytes);
      this.setState(this.parser.current());
    }
  }

  async attach(correlation) {
    const stat = await fs.stat(correlation.transcriptPath);
    const bytes = await readRange(correlation.transcriptPath, 0, stat.size);
    if (!this.active) return;
    this.correlation = correlation;
    this.parser = parserFor(correlation.agent, this.now);
    this.offset = bytes.length;
    this.partial = Buffer.alloc(0);
    this.fileIdentity = `${stat.dev}:${stat.ino}`;
    this.fileMtimeMs = stat.mtimeMs;
    this.lastValidationAt = Date.now();
    this.confirmed = false;
    this.consume(bytes);
    this.openWatcher(correlation.transcriptPath);
    this.setState(this.parser.current());
  }

  consume(bytes) {
    if (!bytes.length) return;
    const combined = this.partial.length ? Buffer.concat([this.partial, bytes]) : bytes;
    let start = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      const line = combined.subarray(start, index).toString("utf8").replace(/\r$/, "");
      start = index + 1;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      this.parser.pushLine(line);
      if (!this.confirmed && recordConfirmsRabbitholeSession(this.correlation.agent, record, this.sessionIds())) this.confirmed = true;
    }
    this.partial = combined.subarray(start);
  }

  openWatcher(filePath) {
    this.closeWatcher();
    try {
      this.watcher = watch(filePath, { persistent: false }, () => this.requestRefresh());
      this.watcher.on("error", () => this.requestRefresh());
    } catch {}
  }

  closeWatcher() {
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
  }

  resetTail() {
    this.correlation = null;
    this.parser = null;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.fileIdentity = null;
    this.fileMtimeMs = 0;
    this.lastValidationAt = 0;
    this.confirmed = false;
  }

  loseCorrelation() {
    this.closeWatcher();
    this.resetTail();
    this.setState(unavailableContextUsage());
  }

  setState(next) {
    if (sameUsage(next, this.current) && !this.pending) return;
    this.pending = next;
    const elapsed = Date.now() - this.lastEmittedAt;
    if (!this.lastEmittedAt || elapsed >= this.throttleMs) this.flushState();
    else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => this.flushState(), this.throttleMs - elapsed);
      this.emitTimer.unref?.();
    }
  }

  flushState() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    if (!this.active || !this.pending) return;
    const next = this.pending;
    this.pending = null;
    if (sameUsage(next, this.current)) return;
    this.current = next;
    this.lastEmittedAt = Date.now();
    for (const { listener } of this.listeners.values()) listener(next);
  }
}

let sharedMonitor = null;

export function getAgentContextMonitor() {
  if (!sharedMonitor) sharedMonitor = new AgentContextMonitor();
  return sharedMonitor;
}
