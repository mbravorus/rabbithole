import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { textConfirmsRabbitholeSession } from "./confirmation.js";

const execFileAsync = promisify(execFile);
const MAX_ANCESTORS = 12;
const CODEX_START_TOLERANCE_MS = 2 * 60 * 1000;
const ACTIVE_MTIME_MS = 10 * 1000;

function agentFromProcess(info) {
  const executable = path.basename(info.executable || "").toLowerCase();
  const command = String(info.command || "").toLowerCase();
  const commandExecutable = path.basename(command.trim().split(/\s+/, 1)[0] || "");
  if (executable === "claude" || executable === "claude-code" || commandExecutable === "claude" || commandExecutable === "claude-code") return "claude";
  if (/app[-_ ]?server/.test(command)) return null;
  if (executable === "codex" || commandExecutable === "codex") return "codex";
  return null;
}

async function run(name, args) {
  try { return (await execFileAsync(name, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
  catch { return ""; }
}

async function processCwd(pid, platform) {
  if (platform === "linux") {
    try { return await fs.readlink(`/proc/${pid}/cwd`); } catch { return null; }
  }
  if (platform === "darwin") {
    const output = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = output.split("\n").find((entry) => entry.startsWith("n"));
    return line ? line.slice(1) : null;
  }
  return null;
}

export async function inspectProcess(pid, { platform = process.platform, includeCwd = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const [ppidText, startText, executable, command] = await Promise.all([
    run("ps", ["-p", String(pid), "-o", "ppid="]),
    run("ps", ["-p", String(pid), "-o", "lstart="]),
    run("ps", ["-p", String(pid), "-o", "comm="]),
    run("ps", ["-p", String(pid), "-o", "command="]),
  ]);
  const ppid = Number.parseInt(ppidText, 10);
  const startTimeMs = Date.parse(startText);
  if (!Number.isInteger(ppid) || !Number.isFinite(startTimeMs) || !executable) return null;
  return {
    pid,
    ppid,
    startTimeMs,
    executable,
    command,
    cwd: includeCwd ? await processCwd(pid, platform) : null,
  };
}

async function findAgentAncestor(startPid, inspect) {
  let pid = startPid;
  const seen = new Set();
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const info = await inspect(pid, { includeCwd: false });
    if (!info) return null;
    const agent = agentFromProcess(info);
    if (agent) return { agent, info: await inspect(pid, { includeCwd: true }) || info };
    pid = info.ppid;
  }
  return null;
}

async function walkFiles(root, accept, files = []) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(entryPath, accept, files);
    else if (entry.isFile() && accept(entry.name)) files.push(entryPath);
  }
  return files;
}

async function locateNamedTranscript(root, name) {
  const matches = await walkFiles(root, (candidate) => candidate === name);
  return matches.length === 1 ? matches[0] : null;
}

async function readText(filePath, { start = 0, length = null } = {}) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const bytes = Math.max(0, Math.min(length ?? (stat.size - start), stat.size - start));
    const buffer = Buffer.alloc(bytes);
    if (bytes) await handle.read(buffer, 0, bytes, start);
    return buffer.toString("utf8");
  } catch { return ""; }
  finally { await handle?.close().catch(() => {}); }
}

async function recentFiles(root, accept, limit = 100) {
  const files = await walkFiles(root, accept);
  const withStats = await Promise.all(files.map(async (filePath) => {
    try { return { path: filePath, stat: await fs.stat(filePath) }; } catch { return null; }
  }));
  return withStats.filter(Boolean).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, limit);
}

async function findConfirmedTranscript(agent, root, accept, sessionIds, processStartMs) {
  if (!sessionIds?.size) return null;
  const candidates = await recentFiles(root, accept);
  const matches = [];
  for (const candidate of candidates) {
    if (candidate.stat.mtimeMs < processStartMs - CODEX_START_TOLERANCE_MS) continue;
    const start = Math.max(0, candidate.stat.size - 256 * 1024);
    const text = await readText(candidate.path, { start, length: candidate.stat.size - start });
    if (textConfirmsRabbitholeSession(agent, text, sessionIds)) matches.push(candidate.path);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function claudeSessionId(homeDir, pid) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(homeDir, ".claude", "sessions", `${pid}.json`), "utf8"));
    return typeof parsed?.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null;
  } catch { return null; }
}

async function macOpenCodexRollouts(pid, homeDir) {
  const root = path.join(homeDir, ".codex", "sessions") + path.sep;
  const output = await run("lsof", ["-a", "-p", String(pid), "-F", "fn"]);
  const paths = [];
  let writable = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("f")) writable = /[wu]$/.test(line);
    else if (line.startsWith("n") && writable) {
      const candidate = line.slice(1);
      if (candidate.startsWith(root) && /^rollout-.*\.jsonl$/.test(path.basename(candidate))) paths.push(candidate);
    }
  }
  return [...new Set(paths)];
}

async function linuxOpenCodexRollouts(pid, homeDir) {
  const root = path.join(homeDir, ".codex", "sessions") + path.sep;
  let names;
  try { names = await fs.readdir(`/proc/${pid}/fd`); } catch { return []; }
  const paths = [];
  for (const name of names) {
    try {
      const [candidate, info] = await Promise.all([
        fs.readlink(`/proc/${pid}/fd/${name}`),
        fs.readFile(`/proc/${pid}/fdinfo/${name}`, "utf8"),
      ]);
      const flagsText = /^flags:\s*([0-7]+)/m.exec(info)?.[1];
      const flags = flagsText ? Number.parseInt(flagsText, 8) : 0;
      const writable = (flags & 3) === 1 || (flags & 3) === 2;
      if (writable && candidate.startsWith(root) && /^rollout-.*\.jsonl$/.test(path.basename(candidate))) paths.push(candidate);
    } catch {}
  }
  return [...new Set(paths)];
}

async function openCodexRollouts(pid, homeDir, platform) {
  if (platform === "darwin") return macOpenCodexRollouts(pid, homeDir);
  if (platform === "linux") return linuxOpenCodexRollouts(pid, homeDir);
  return [];
}

async function readCodexSessionMeta(filePath) {
  const prefix = await readText(filePath, { length: 64 * 1024 });
  for (const line of prefix.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "session_meta") return record;
    } catch {}
  }
  return null;
}

function codexMetaMatches(meta, processInfo) {
  const payload = meta?.payload;
  if (!payload) return false;
  const timestamp = Date.parse(payload.timestamp ?? meta.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp - processInfo.startTimeMs) > CODEX_START_TOLERANCE_MS) return false;
  if (!processInfo.cwd || typeof payload.cwd !== "string" || path.resolve(payload.cwd) !== path.resolve(processInfo.cwd)) return false;
  const source = `${payload.originator || ""} ${payload.source || ""}`;
  return /codex|cli/i.test(source) && !/desktop|app[-_ ]?server/i.test(source);
}

export class AgentCorrelator {
  constructor({
    homeDir = os.homedir(),
    platform = process.platform,
    inspect = (pid, options) => inspectProcess(pid, { platform, ...options }),
    listOpenCodexRollouts = (pid) => openCodexRollouts(pid, homeDir, platform),
    now = () => Date.now(),
  } = {}) {
    this.homeDir = homeDir;
    this.platform = platform;
    this.inspect = inspect;
    this.listOpenCodexRollouts = listOpenCodexRollouts;
    this.now = now;
    this.fallbackMtimes = new Map();
  }

  async discover({ startPid = process.ppid, sessionIds = new Set() } = {}) {
    const ancestor = await findAgentAncestor(startPid, this.inspect);
    if (!ancestor?.info) return null;
    return ancestor.agent === "claude"
      ? this.discoverClaude(ancestor.info, sessionIds)
      : this.discoverCodex(ancestor.info, sessionIds);
  }

  async discoverClaude(info, sessionIds) {
    const projectsRoot = path.join(this.homeDir, ".claude", "projects");
    const sessionId = await claudeSessionId(this.homeDir, info.pid);
    let transcriptPath = sessionId ? await locateNamedTranscript(projectsRoot, `${sessionId}.jsonl`) : null;
    let confidence = "primary";
    if (!transcriptPath) {
      transcriptPath = await findConfirmedTranscript("claude", projectsRoot, (name) => name.endsWith(".jsonl"), sessionIds, info.startTimeMs);
      confidence = "confirmed_fallback";
    }
    if (!transcriptPath) return null;
    const identity = { pid: info.pid, startTimeMs: info.startTimeMs, executable: info.executable, cwd: info.cwd || null };
    return {
      agent: "claude",
      transcriptPath,
      confidence,
      identity,
      validationIntervalMs: 1500,
      validate: async () => {
        if (!await this.sameProcess(identity)) return false;
        if (!sessionId) return true;
        return await claudeSessionId(this.homeDir, info.pid) === sessionId;
      },
    };
  }

  async discoverCodex(info, sessionIds) {
    const open = await this.listOpenCodexRollouts(info.pid);
    let transcriptPath = open.length === 1 ? open[0] : null;
    let confidence = "primary";
    if (!transcriptPath) {
      transcriptPath = await this.codexFallback(info, sessionIds);
      confidence = "fallback";
    }
    if (!transcriptPath) return null;
    const identity = { pid: info.pid, startTimeMs: info.startTimeMs, executable: info.executable, cwd: info.cwd || null };
    return {
      agent: "codex",
      transcriptPath,
      confidence,
      identity,
      validationIntervalMs: confidence === "primary" ? 10_000 : 3000,
      validate: async () => {
        if (!await this.sameProcess(identity)) return false;
        if (confidence !== "primary") return true;
        return (await this.listOpenCodexRollouts(info.pid)).includes(transcriptPath);
      },
    };
  }

  async codexFallback(info, sessionIds) {
    const root = path.join(this.homeDir, ".codex", "sessions");
    const candidates = await recentFiles(root, (name) => /^rollout-.*\.jsonl$/.test(name));
    const matches = [];
    for (const candidate of candidates) {
      const meta = await readCodexSessionMeta(candidate.path);
      if (!codexMetaMatches(meta, info)) continue;
      const previousMtime = this.fallbackMtimes.get(candidate.path);
      this.fallbackMtimes.set(candidate.path, candidate.stat.mtimeMs);
      const changing = previousMtime == null
        ? this.now() - candidate.stat.mtimeMs <= ACTIVE_MTIME_MS
        : candidate.stat.mtimeMs > previousMtime || this.now() - candidate.stat.mtimeMs <= ACTIVE_MTIME_MS;
      if (!changing) continue;
      const start = Math.max(0, candidate.stat.size - 256 * 1024);
      const tail = await readText(candidate.path, { start, length: candidate.stat.size - start });
      matches.push({ path: candidate.path, confirmed: textConfirmsRabbitholeSession("codex", tail, sessionIds) });
    }
    const confirmed = matches.filter((candidate) => candidate.confirmed);
    if (confirmed.length === 1) return confirmed[0].path;
    return matches.length === 1 ? matches[0].path : null;
  }

  async sameProcess(identity) {
    const current = await this.inspect(identity.pid, { includeCwd: false });
    return !!current && current.startTimeMs === identity.startTimeMs && current.executable === identity.executable;
  }
}
