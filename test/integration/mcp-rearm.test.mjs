import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-mcp-rearm-"));

const { openRabbithole, answerBranch } = await import("../../src/node/rabbithole.js");
const { closeAllSessions, getSession } = await import("../../src/node/sessions.js");
const { defaultFsStore } = await import("../../src/node/fs-store.js");
const { toolDefinitions } = await import("../../src/node/tools/manifest.js");
const { RabbitHoleSession } = await import("../../src/node/transport/session.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortAfter(ms = 25) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function detachEvents(session) {
  return session.outboundEvents.filter((event) => event.data.type === "agent_status" && event.data.attached === false);
}

function rootNode(id = "root") {
  return {
    id,
    parent_id: null,
    title: "Root",
    markdown: "Root",
    base_url: null,
    base_url_source: null,
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: new Date().toISOString(),
  };
}

function useFakeTimeouts() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0;
  let nextId = 1;

  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const id = nextId++;
    timers.set(id, { at: now + Number(delay), callback: () => callback(...args) });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);

  return {
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

class FakeSseRequest extends EventEmitter {
  constructor(url = "/sse") {
    super();
    this.method = "GET";
    this.url = url;
    this.headers = {};
  }
}

class FakeSseResponse {
  constructor() {
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {}
}

async function runTransientSseReconnectFixture() {
  const fakeTimeouts = useFakeTimeouts();
  let session;
  let firstRequest;
  let reconnectRequest;
  try {
    session = new RabbitHoleSession({
      holeId: "transient-sse-reconnect",
      title: "Transient SSE Reconnect",
      rootId: "root",
      nodes: [rootNode()],
      isResume: false,
      renderPage: () => "",
    });
    session.url = "http://127.0.0.1";

    let waiterSettled = false;
    const durableWaiter = session.waitForEvent().then((event) => {
      waiterSettled = true;
      return event;
    });
    firstRequest = new FakeSseRequest();
    const firstResponse = new FakeSseResponse();
    await session.handleRequest(firstRequest, firstResponse);
    assert.equal(firstResponse.status, 200);
    assert.equal(session.sseClients.size, 1);

    firstRequest.emit("close");
    assert.equal(session.sseClients.size, 0, "losing the last SSE client marks the browser disconnected");
    fakeTimeouts.advance(60_001);
    await Promise.resolve();
    assert.equal(session.closed, false, "SSE loss must not close the session after the former grace window");
    assert.equal(waiterSettled, false, "SSE loss must not resolve the durable agent waiter");

    reconnectRequest = new FakeSseRequest("/sse?after=0");
    const reconnectResponse = new FakeSseResponse();
    await session.handleRequest(reconnectRequest, reconnectResponse);
    session.broadcast({ type: "agent_status", attached: true, reason: "reconnect_test" });
    assert.match(reconnectResponse.chunks.join(""), /"type":"agent_status"/, "a reconnected SSE client receives later events");

    await session.handleBrowserEvent({
      type: "branch_request",
      parent_id: session.rootId,
      request_id: "request-after-reconnect",
      node_id: "node-after-reconnect",
      selected_text: "Root",
      question: "Does delivery survive the reconnect?",
    });
    const delivered = await durableWaiter;
    assert.equal(delivered.status, "branch_request");
    assert.equal(delivered.request_id, "request-after-reconnect");
  } finally {
    firstRequest?.emit("close");
    reconnectRequest?.emit("close");
    fakeTimeouts.restore();
    await session?.close("sse_reconnect_test_complete");
  }

  console.log("ok SSE reconnect: transient loss stays live past 60s and preserves bidirectional delivery");
}

async function runZeroIdleTurnsAndSingleListenerFixture() {
  const openingController = new AbortController();
  const opening = openRabbithole({ title: "MCP Listener", content: "Root", signal: openingController.signal });
  await sleep(25);
  openingController.abort();
  const opened = await opening;
  assert.equal(opened.status, "cancelled");

  const session = getSession(opened.session_id);
  assert(session, "cancelled host wait should leave the durable canvas session live");
  assert.equal(session.agentAttached, false);

  // Even a legacy local override must not be able to reintroduce model
  // polling. This makes the zero-idle-turn invariant fast to test.
  process.env.RABBITHOLE_MAX_BLOCK_MS = "50";
  const idle = session.waitForEvent();
  const idleOutcome = await Promise.race([idle.then(() => "resolved"), sleep(125).then(() => "pending")]);
  delete process.env.RABBITHOLE_MAX_BLOCK_MS;
  assert.equal(idleOutcome, "pending", "an idle canvas must not periodically resolve its model listener");
  assert(session.waiter, "one background listener should remain attached during idle time");
  assert.equal(session.agentAttached, true);

  const overlapping = await session.waitForEvent();
  assert.deepEqual(overlapping, {
    status: "already_listening",
    session_id: session.id,
    hole_id: session.holeId,
    instruction: "This session already has an active background listener. Do not attach another one; the existing call will receive the next canvas event.",
  });
  assert(session.waiter, "a redundant attach must not replace the owning listener");

  await defaultFsStore.putAsset(session.holeId, "paste-live.png", Buffer.from([1, 2, 3, 4]));
  session.assetNames.add("paste-live.png");
  const ask = await session.handleBrowserEvent({
    type: "branch_request",
    parent_id: session.rootId,
    request_id: "req-live",
    node_id: "node-live",
    selected_text: "Root",
    question: "Explain this",
    attachment_assets: ["paste-live.png"],
  });
  assert.equal(session.queue.length, 0, "the active listener should receive the ask directly");

  const branch = await idle;
  assert.equal(branch.status, "branch_request");
  assert.equal(branch.request_id, ask.request_id);
  assert.equal(branch.node_id, ask.node_id);
  assert.equal(branch.session_id, session.id);
  assert.equal(branch.attachments.length, 1);
  assert.equal(branch.attachments[0].kind, "image");
  assert.equal(branch.attachments[0].source, "pasted_image");
  assert.equal(path.isAbsolute(branch.attachments[0].image_path), true);
  await fs.realpath(branch.attachments[0].image_path);
  assert.deepEqual(await fs.readFile(branch.attachments[0].image_path), Buffer.from([1, 2, 3, 4]));
  assert.equal(session.waiter, null);

  const answerController = new AbortController();
  setTimeout(() => answerController.abort(), 25);
  const afterAnswer = await answerBranch({
    sessionId: branch.session_id,
    requestId: branch.request_id,
    title: "Answer",
    content: "Answered.",
    signal: answerController.signal,
  });
  assert.equal(afterAnswer.status, "cancelled");
  assert.equal(session.pendingByRequest.size, 0);
  assert.equal(session.inFlightBranchRequests.size, 0);

  const duplicate = await answerBranch({
    sessionId: branch.session_id,
    requestId: branch.request_id,
    title: "Duplicate answer",
    content: "Must not be written twice.",
  });
  assert.deepEqual(duplicate, {
    ok: true, node_id: ask.node_id, request_id: ask.request_id, duplicate: true, completed: true,
  }, "a retried completed request should be an idempotent acknowledgement");
  assert.equal(session.nodes.get(ask.node_id).markdown, "Answered.");

  const liveController = new AbortController();
  const liveListener = openRabbithole({ holeId: session.holeId, signal: liveController.signal });
  await sleep(20);
  const redundantLiveAttach = await openRabbithole({ holeId: session.holeId });
  assert.equal(redundantLiveAttach.status, "already_listening");
  liveController.abort();
  assert.equal((await liveListener).status, "cancelled");
  assert.equal(session.waiter, null, "hard cancellation should release the sole listener");
  assert.equal(detachEvents(session).at(-1)?.data.reason, "cancelled");

  console.log("ok listener: zero idle turns, one delivery lease, idempotent completion, and cancellation cleanup");
}

async function runOrphanedWaiterRecoveryFixture() {
  const opened = await openRabbithole({ title: "MCP orphan recovery", content: "Root", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);

  const orphaned = session.waitForEvent();
  assert.equal((await openRabbithole({ holeId: session.holeId })).status, "already_listening");
  const ask = await session.handleBrowserEvent({
    type: "branch_request",
    parent_id: session.rootId,
    request_id: "req-orphaned",
    node_id: "node-orphaned",
    selected_text: "Root",
    question: "Can this ask recover?",
  });
  const lostDelivery = await orphaned;
  assert.equal(lostDelivery.request_id, ask.request_id, "the orphaned waiter receives the first delivery");
  assert.equal(session.waiter, null, "delivery clears the orphaned waiter before resolving it");
  assert.equal(session.inFlightBranchRequests.get(ask.request_id), lostDelivery);
  await session.flushSave();
  assert.equal((await defaultFsStore.loadHole(session.holeId)).nodes.find((node) => node.id === ask.node_id)?.status, "pending");

  const recovered = await openRabbithole({ holeId: session.holeId });
  assert.equal(recovered.status, "branch_request");
  assert.equal(recovered.request_id, ask.request_id, "the next attach redelivers the exact in-flight ask");
  assert.equal(recovered.node_id, ask.node_id);
  const afterAnswer = await answerBranch({
    sessionId: recovered.session_id,
    requestId: recovered.request_id,
    title: "Recovered answer",
    content: "Recovered.",
    signal: abortAfter(),
  });
  assert.equal(afterAnswer.status, "cancelled");
  assert.equal(session.nodes.get(ask.node_id).markdown, "Recovered.");
  assert.equal(session.pendingByRequest.size, 0);
  assert.equal(session.inFlightBranchRequests.size, 0);
  assert.equal(session.waiter, null);

  console.log("ok listener recovery: an orphan-delivered ask persists, redelivers, answers, and re-arms once");
}

async function runProgressKeepaliveFixture() {
  const openTool = toolDefinitions.find((tool) => tool.name === "open_rabbithole");
  const answerTool = toolDefinitions.find((tool) => tool.name === "answer_branch");
  assert(openTool && answerTool);
  process.env.RABBITHOLE_PROGRESS_INTERVAL_MS = "10";
  try {
    const openingController = new AbortController();
    const openNotifications = [];
    const opened = await openTool.run(
      { title: "MCP progress", content: "Root" },
      {
        signal: openingController.signal,
        _meta: { progressToken: "open-token" },
        async sendNotification(notification) {
          openNotifications.push(notification);
          openingController.abort();
        },
      }
    );
    assert.equal(opened.status, "cancelled");
    assert.deepEqual(openNotifications, [{
      method: "notifications/progress",
      params: { progressToken: "open-token", progress: 1, message: "Waiting for canvas activity." },
    }]);

    const session = getSession(opened.session_id);
    const waiting = session.waitForEvent();
    await session.handleBrowserEvent({
      type: "branch_request",
      parent_id: session.rootId,
      request_id: "req-progress",
      node_id: "node-progress",
      selected_text: "Root",
      question: "Keep waiting?",
    });
    const branch = await waiting;
    const answerController = new AbortController();
    const answerNotifications = [];
    const answered = await answerTool.run(
      {
        session_id: branch.session_id,
        request_id: branch.request_id,
        title: "Progress answer",
        content: "Yes.",
      },
      {
        signal: answerController.signal,
        _meta: { progressToken: 47 },
        async sendNotification(notification) {
          answerNotifications.push(notification);
          answerController.abort();
        },
      }
    );
    assert.equal(answered.status, "cancelled");
    assert.deepEqual(answerNotifications, [{
      method: "notifications/progress",
      params: { progressToken: 47, progress: 1, message: "Waiting for canvas activity." },
    }]);

    let tokenlessNotifications = 0;
    const tokenlessController = new AbortController();
    const tokenlessWait = openTool.run(
      { hole_id: session.holeId },
      {
        signal: tokenlessController.signal,
        _meta: {},
        async sendNotification() { tokenlessNotifications += 1; },
      }
    );
    setTimeout(() => tokenlessController.abort(), 30);
    assert.equal((await tokenlessWait).status, "cancelled");
    assert.equal(tokenlessNotifications, 0, "a client without a progress token gets no fabricated notification");
  } finally {
    delete process.env.RABBITHOLE_PROGRESS_INTERVAL_MS;
  }

  console.log("ok progress: token-gated keepalives cover open and final-answer waits");
}

async function runSavedAskRequeueFixture() {
  const holeId = "mcp-rearm-saved";
  const root = rootNode();
  const child = {
    id: "saved-child",
    parent_id: null,
    title: "Saved question",
    markdown: "",
    base_url: null,
    base_url_source: null,
    origin: {
      selected_text: "stale standalone selection",
      question: "Saved while away?",
      lens: null,
      anchor: null,
      branch_type: "followup",
      attachment_assets: ["../escape.png", "source.pdf", "paste-saved.png"],
    },
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "pending",
    read: false,
    created_at: "2026-08-13T00:00:00.000Z",
  };
  const laterChild = {
    ...child,
    id: "saved-child-later",
    title: "Later saved question",
    origin: { ...child.origin, question: "Does the next saved ask still arrive?", attachment_assets: [] },
    created_at: "2026-08-13T00:00:01.000Z",
  };

  await defaultFsStore.putAsset(holeId, "paste-saved.png", Buffer.from([5, 6, 7, 8]));

  await defaultFsStore.saveHole({
    hole_id: holeId,
    title: "MCP Rearm Saved",
    root_id: "root",
    created_at: new Date().toISOString(),
    nodes: [
      root,
      child,
      laterChild,
    ],
  });

  const saved = await openRabbithole({ holeId });
  assert.equal(saved.status, "branch_request");
  assert.equal(saved.saved, true);
  assert.equal(saved.node_id, "saved-child");
  assert.equal(saved.parent_node_id, "root", "saved standalone asks resume with root as their context source");
  assert.equal(saved.parent_node_title, "Root");
  assert.equal(saved.selected_text, "", "saved standalone asks retain whole-hole selection semantics");
  assert.deepEqual(saved.lineage, ["Root"]);
  assert.equal(saved.attachments.length, 1, "saved asks re-resolve their pasted images after restart");
  assert.equal(saved.attachments[0].kind, "image");
  assert.equal(saved.attachments[0].source, "pasted_image");
  assert.equal(path.isAbsolute(saved.attachments[0].image_path), true);
  await fs.realpath(saved.attachments[0].image_path);
  assert.deepEqual(await fs.readFile(saved.attachments[0].image_path), Buffer.from([5, 6, 7, 8]));
  assert(saved.rehydration, "first saved ask should include rehydration");
  assert.deepEqual(saved.rehydration.saved_asks, [{
    node_id: "saved-child", question: "Saved while away?", selected_text: "",
  }, {
    node_id: "saved-child-later", question: "Does the next saved ask still arrive?", selected_text: "",
  }]);

  const session = getSession(saved.session_id);
  assert(session, "cold resume should create a live session");
  assert.equal(session.queue.length, 1, "the later saved ask should already be queued behind the first delivery");

  const afterAnswer = await answerBranch({
    sessionId: saved.session_id,
    requestId: saved.request_id,
    title: "Saved answer",
    content: "Saved answer.",
  });
  assert.equal(afterAnswer.status, "branch_request", "a bad saved attachment name must not wedge the later saved-ask requeue");
  assert.equal(afterAnswer.node_id, "saved-child-later");
  assert.equal(afterAnswer.question, "Does the next saved ask still arrive?");
  const afterLaterAnswer = await answerBranch({
    sessionId: afterAnswer.session_id,
    requestId: afterAnswer.request_id,
    title: "Later saved answer",
    content: "Later saved answer.",
    signal: abortAfter(),
  });
  assert.equal(afterLaterAnswer.status, "cancelled");
  assert.equal([...session.nodes.values()].filter((node) => node.status === "pending").length, 0);
  assert.equal(session.nodes.get("saved-child").parent_id, null, "answering a saved standalone ask keeps it disconnected");
  assert.equal(session.pendingByRequest.size, 0);
  assert.equal(session.inFlightBranchRequests.size, 0);

  const liveAgain = await openRabbithole({ holeId, signal: abortAfter() });
  assert.equal(liveAgain.status, "cancelled");
  assert.equal(session.queue.length, 0, "live reattach should not requeue saved asks again");
  assert.equal(session.waiter, null);

  console.log("ok rearm: invalid saved attachment names do not block valid delivery or later saved asks");
}

// The wire entry a note node should produce (standalone by default; anchored
// entries override on_node_id/on_selected_text, lineage entries add the flag).
function noteEntry(session, id, content, extra = {}) {
  return { note_id: id, on_node_id: null, on_selected_text: null, content, created_at: session.nodes.get(id).created_at, ...extra };
}

async function runNotesContextFixture() {
  const opened = await openRabbithole({ title: "MCP notes context", content: "Root note target", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);

  await session.handleBrowserEvent({
    type: "node_create",
    id: "replied-note",
    markdown: "Keep the target caveat in mind.",
    origin: { kind: "note" },
  });
  await session.handleBrowserEvent({
    type: "node_create",
    id: "ambient-note-one",
    markdown: "Relate this to the broader argument.",
    origin: { kind: "note" },
  });
  await session.handleBrowserEvent({
    type: "node_create",
    id: "ambient-note-two",
    markdown: "Compare this with the appendix.",
    origin: { kind: "note" },
  });
  assert.deepEqual(session.queue, [], "note creation must remain pull-only for the agent");

  await session.handleBrowserEvent({
    type: "branch_request",
    request_id: "notes-request",
    node_id: "notes-branch",
    parent_id: "replied-note",
    selected_text: "",
    question: "Expand on this note",
  });
  const branch = await openRabbithole({ holeId: session.holeId });
  const expectedNotes = [
    noteEntry(session, "replied-note", "Keep the target caveat in mind.", { on_lineage: true }),
    noteEntry(session, "ambient-note-one", "Relate this to the broader argument."),
    noteEntry(session, "ambient-note-two", "Compare this with the appendix."),
  ];
  assert.deepEqual(branch.notes, expectedNotes, "a live follow-up inside one of three notes delivers all three with the replied-to note flagged first");
  const expectedAllNotes = [
    noteEntry(session, "replied-note", "Keep the target caveat in mind."),
    ...expectedNotes.slice(1),
  ];

  const holeId = session.holeId;
  await session.close("notes_context_cold_resume");
  const resumed = await openRabbithole({ holeId });
  assert.equal(resumed.status, "branch_request");
  assert.equal(resumed.saved, true);
  assert.deepEqual(resumed.notes, expectedNotes, "saved branch delivery recomputes lineage-aware note context after cold resume");
  assert.deepEqual(resumed.rehydration.notes, expectedAllNotes, "cold resume carries all active notes without lineage presentation flags");
  assert.equal(resumed.rehydration.nodes.find((node) => node.id === "replied-note")?.kind, "note");
  assert.equal(resumed.rehydration.nodes.find((node) => node.id === "ambient-note-one")?.kind, "note");
  assert.equal(resumed.rehydration.nodes.find((node) => node.id === "ambient-note-two")?.kind, "note");
  assert.equal(Object.hasOwn(resumed.rehydration.nodes.find((node) => node.id === session.rootId), "kind"), false, "non-note rehydration nodes stay untagged");

  console.log("ok rearm notes: three-note reply thread, lineage flag, and cold-resume note rehydration");
}

async function runDoneNotesDeliveryFixture() {
  const opened = await openRabbithole({ title: "MCP notes on Done", content: "Root feedback target", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);

  await session.handleBrowserEvent({
    type: "node_create",
    id: "done-anchored-note",
    parent_id: session.rootId,
    markdown: "Tighten this paragraph.",
    origin: { kind: "note", selected_text: "feedback target", anchor: { offset_start: 5, offset_end: 20 } },
  });
  await session.handleBrowserEvent({
    type: "node_create",
    id: "done-standalone-note",
    markdown: "Check the conclusion too.",
    origin: { kind: "note" },
  });

  const blocked = session.waitForEvent();
  assert(session.waiter, "the agent call should be blocked before Done");
  assert.deepEqual(await session.handleBrowserEvent({ type: "done" }), { ok: true });
  assert.deepEqual(await blocked, {
    status: "session_closed",
    session_id: session.id,
    reason: "done",
    notes: [
      noteEntry(session, "done-standalone-note", "Check the conclusion too."),
      noteEntry(session, "done-anchored-note", "Tighten this paragraph.", { on_node_id: session.rootId, on_selected_text: "feedback target" }),
    ],
  }, "Done resolves the blocked agent call with every note in the hole");
  assert.equal(session.watchdogTimer, null, "session_closed delivery must not arm the answer watchdog");
  assert.equal(session.inFlightBranchRequests.size, 0, "session_closed delivery must not enter branch request tracking");

  console.log("ok rearm notes: Done delivers all notes without arming branch lifecycle state");
}

try {
  await runTransientSseReconnectFixture();
  await runZeroIdleTurnsAndSingleListenerFixture();
  await runOrphanedWaiterRecoveryFixture();
  await runProgressKeepaliveFixture();
  await runSavedAskRequeueFixture();
  await runNotesContextFixture();
  await runDoneNotesDeliveryFixture();
} finally {
  await closeAllSessions("mcp_rearm_test_complete");
}

console.log("MCP rearm verification passed");
