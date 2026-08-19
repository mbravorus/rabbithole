import assert from "node:assert/strict";
import { CANVAS_SHELL } from "../../src/core/html/shell.js";
import { CANVAS_STYLES } from "../../src/core/html/styles.js";
import { RabbitHoleSession } from "../../src/node/transport/session.js";

const session = new RabbitHoleSession({
  holeId: "context-wire-hole",
  title: "Context wire",
  rootId: "root",
  nodes: [{
    id: "root", parent_id: null, title: "Root", markdown: "Fixture", origin: null,
    position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false,
    status: "answered", read: true, created_at: "2026-08-12T00:00:00.000Z",
  }],
  isResume: false,
  renderPage: () => "",
});

const reported = {
  type: "context_usage", quality: "reported", agent: "codex", model: "gpt-fixture",
  used_tokens: 42, window_tokens: 100, percent: 42, measured_at: "2026-08-12T00:00:00.000Z",
  transcript_path: "/must/not/cross/the/wire",
};
session.setContextUsage(reported);
const hydration = session.buildHydration();
assert.deepEqual(hydration.context_usage, {
  type: "context_usage", quality: "reported", agent: "codex", model: "gpt-fixture",
  used_tokens: 42, window_tokens: 100, percent: 42, measured_at: "2026-08-12T00:00:00.000Z",
});
assert.equal("context_usage" in session.toHole(), false, "context usage must not enter persisted hole JSON");
assert.equal(JSON.stringify(session.toHole()).includes("transcript"), false);
session.setContextBusy(true);
assert.equal(session.buildHydration().context_usage.quality, "stale", "an in-flight agent turn should retain the exact counters as last measured");
session.setContextBusy(false);

const { transcript_path: _discarded, ...wireReported } = reported;
session.broadcast({ ...wireReported, used_tokens: 43, percent: 43 });
session.broadcast({ ...wireReported, used_tokens: 44, percent: 44 });
assert.equal(session.outboundEvents.filter((event) => event.data.type === "context_usage").length, 1, "replay should retain only the latest context reading");
assert.equal(session.outboundEvents.find((event) => event.data.type === "context_usage").data.used_tokens, 44);

assert(CANVAS_SHELL.includes('id="context-usage" hidden'), "the indicator should default hidden in web/frozen shells");
assert(CANVAS_STYLES.includes("body.frozen #context-usage"), "frozen snapshots should force the indicator hidden");

console.log("ok context usage wire: transient hydration, sanitized counters, coalesced replay, hidden shell");
