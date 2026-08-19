import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeTranscript } from "../../src/node/context/claude.js";
import { parseCodexTranscript } from "../../src/node/context/codex.js";
import { AgentCorrelator } from "../../src/node/context/correlation.js";
import { AgentContextMonitor } from "../../src/node/context/monitor.js";
import { reportedContextUsage } from "../../src/node/context/usage.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "context");
const fixture = (name) => fs.readFile(path.join(fixtureDir, name), "utf8");

const claude = parseClaudeTranscript(await fixture("claude.jsonl"));
assert.equal(claude.quality, "reported");
assert.equal(claude.agent, "claude");
assert.equal(claude.model, "claude-fable-5");
assert.equal(claude.used_tokens, 1000, "Claude should sum only the four top-level usage fields");
assert.equal(claude.window_tokens, 1_000_000);
assert.equal(claude.percent, 0.1);
assert.equal(claude.measured_at, "2026-08-12T08:00:02.000Z");

const unknownClaude = parseClaudeTranscript(await fixture("claude-unknown-model.jsonl"));
assert.equal(unknownClaude.quality, "unavailable", "an unknown Claude model must not inherit a context window");
assert.equal(unknownClaude.model, "claude-future-unknown");

const malformedClaude = parseClaudeTranscript(await fixture("claude-malformed-latest.jsonl"));
assert.equal(malformedClaude.quality, "unavailable", "a malformed latest Claude record must replace an older valid reading");

const codex = parseCodexTranscript(await fixture("codex.jsonl"));
assert.equal(codex.quality, "reported");
assert.equal(codex.agent, "codex");
assert.equal(codex.model, "gpt-5.6-sol");
assert.equal(codex.used_tokens, 91_008, "Codex should use last_token_usage.total_tokens without adding subsets");
assert.equal(codex.window_tokens, 258_400);
assert(Math.abs(codex.percent - (100 * 91_008 / 258_400)) < 1e-12);
assert.equal(codex.measured_at, "2026-08-12T08:10:03.000Z");
assert.equal(parseCodexTranscript(await fixture("codex-malformed-latest.jsonl")).quality, "unavailable");

assert.equal(reportedContextUsage({ agent: "codex", model: "fixture", usedTokens: -1, windowTokens: 100, measuredAt: "x" }).quality, "unavailable");
assert.equal(reportedContextUsage({ agent: "codex", model: "fixture", usedTokens: 101, windowTokens: 100, measuredAt: "x" }).quality, "unavailable");
assert.equal(reportedContextUsage({ agent: "codex", model: "fixture", usedTokens: 100, windowTokens: 100, measuredAt: "x" }).percent, 100);

const fakeProcesses = new Map([
  [300, { pid: 300, ppid: 200, startTimeMs: 3000, executable: "/usr/bin/sh", command: "sh -c rabbithole", cwd: "/fixture" }],
  [200, { pid: 200, ppid: 100, startTimeMs: 2000, executable: "/opt/codex", command: "/opt/codex", cwd: "/fixture" }],
]);
const codexCorrelator = new AgentCorrelator({
  homeDir: tmpHomePlaceholder(),
  inspect: async (pid) => fakeProcesses.get(pid) || null,
  listOpenCodexRollouts: async () => [path.join(fixtureDir, "codex.jsonl")],
});
const correlatedCodex = await codexCorrelator.discover({ startPid: 300 });
assert.equal(correlatedCodex.agent, "codex");
assert.equal(correlatedCodex.transcriptPath, path.join(fixtureDir, "codex.jsonl"));
assert.equal(correlatedCodex.identity.startTimeMs, 2000, "correlation should retain process start time to guard PID reuse");

// The monitor test injects the correlation seam and operates only on a copied
// fixture. It never inspects a live PID or a real ~/.claude / ~/.codex path.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-context-"));
const transcriptPath = path.join(tmp, "claude.jsonl");
await fs.copyFile(path.join(fixtureDir, "claude.jsonl"), transcriptPath);
let correlateCalls = 0;
const monitor = new AgentContextMonitor({
  correlate: async () => {
    correlateCalls += 1;
    return { agent: "claude", transcriptPath, validationIntervalMs: 20, validate: async () => true };
  },
  pollMs: 20,
  throttleMs: 20,
});
const readings = [];
const unsubscribe = monitor.subscribe((usage) => readings.push(usage), { sessionId: "fixture-session" });
await waitFor(() => readings.some((usage) => usage.used_tokens === 1000));
await fs.appendFile(transcriptPath, await fixture("claude-append.jsonl"));
await waitFor(() => readings.some((usage) => usage.used_tokens === 10_000));
await fs.writeFile(transcriptPath, await fixture("claude.jsonl"));
await waitFor(() => correlateCalls >= 2);
unsubscribe();
assert.equal(monitor.running, false, "the final unsubscribe should stop polling");
assert(correlateCalls >= 2, "truncation should discard the tail and rediscover the transcript");
await fs.rm(tmp, { recursive: true, force: true });

console.log("ok context usage: fixture parsers, validation, incremental tail, and injected correlation seam");

function tmpHomePlaceholder() {
  return path.join(os.tmpdir(), "rabbithole-context-unused-home");
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for context monitor fixture");
}
