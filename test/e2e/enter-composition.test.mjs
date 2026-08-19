import assert from "node:assert/strict";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { bootWebApp } from "../support/web-app-harness.mjs";

const app = await bootWebApp();
const { browser, baseUrl } = app;

try {
  await verifyEnterCompositionAndNewlines();
  console.log("enter composition verification passed");
} finally {
  await app.close();
}

async function verifyEnterCompositionAndNewlines() {
  const start = await openTestPage([["TITLE: Composer Enter\n", "Composer Enter completed."]]);
  try {
    await verifyStartComposer(start.page, () => start.providerCalls);
    assert.equal(start.providerCalls, 1, "plain Enter should submit the start composer exactly once");
  } finally {
    await start.context.close();
  }

  const documentPage = await openTestPage([
    ["TITLE: Selection Enter\n", "Selection Enter completed."],
    ["TITLE: Reader Enter\n", "Reader Enter completed."],
    ["TITLE: Reader Lens\n", "Reader lens completed."],
    ["TITLE: Card Enter\n", "Card Enter completed."],
    ["TITLE: Card Lens\n", "Card lens completed."],
    ["TITLE: Standalone Enter\n", "Standalone composer ask completed."],
  ]);
  try {
    await createDocument(documentPage.page, "# Enter handling\n\nEuler identity lets us test selection and follow-up inputs.");
    await documentPage.page.locator(".node .doc-content", { hasText: "Euler identity" }).first().waitFor();
    await verifySelectionCommitKeys(documentPage.page, () => documentPage.providerCalls);
    await verifyReaderComposer(documentPage.page, () => documentPage.providerCalls);
    await verifyCardComposer(documentPage.page, () => documentPage.providerCalls);
    await verifyStandaloneComposer(documentPage.page, () => documentPage.providerCalls);
    assert.equal(documentPage.providerCalls, 6, "each in-document ask submit should call the provider exactly once");
  } finally {
    await documentPage.context.close();
  }

  await verifyPendingRootStandaloneComposer();
}

async function verifyPendingRootStandaloneComposer() {
  process.env.RABBITHOLE_NO_BROWSER = "1";
  const [{ createSession }, { buildCanvasHtml }, { defaultFsStore }] = await Promise.all([
    import("../../src/node/sessions.js"),
    import("../../src/node/html/canvas.js"),
    import("../../src/node/fs-store.js"),
  ]);
  const holeId = `pending-root-e2e-${Date.now()}`;
  await defaultFsStore.putAsset(holeId, "paste-selected.png", Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const root = {
    id: "root", parent_id: null, title: "Pending root", markdown: "", origin: null,
    position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false,
    status: "pending", read: true, created_at: new Date().toISOString(), extensions: {},
  };
  const selectedAttachment = {
    id: "selected-attachment", parent_id: "root", title: "Selected attachment", markdown: "Rendered answer",
    origin: { selected_text: "quoted source", question: "What is shown?", lens: null, anchor: null,
      branch_type: "selection", attachment_assets: ["paste-selected.png"] },
    position: { x: 360, y: 0 }, size: null, font_scale: 1, collapsed: false,
    status: "answered", read: false, created_at: new Date().toISOString(), extensions: {},
  };
  const session = await createSession({
    holeId, title: "Pending root E2E", rootId: "root", nodes: [root, selectedAttachment],
    assetNames: new Set(["paste-selected.png"]), isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(session.url, { waitUntil: "domcontentloaded" });
    await page.locator('.node[data-id="selected-attachment"] .origin-quote .origin-attachment-strip img').waitFor();
    assert.equal(await page.locator('.node[data-id="selected-attachment"] .origin-quote').innerText(), "“quoted source”",
      "selected_text and attachment thumbnails must coexist on the canvas card");

    let point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    let draft = page.locator(".node.note-draft");
    let editor = draft.locator(".note-editor");
    await editor.fill("Note while the root is pending");
    assert.deepEqual(await draft.locator(".ask-commit").evaluateAll((buttons) => buttons.map((button) => button.disabled)), [false, true],
      "a pending root must disable only standalone Ask, not Note");
    assert.equal(await editor.getAttribute("placeholder"), "Ask or note…", "the pending root must keep the standalone live placeholder");
    await draft.locator('[data-commit="note"]').click();
    await page.locator(".node-note .doc-content", { hasText: "Note while the root is pending" }).waitFor();

    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    draft = page.locator(".node.note-draft");
    editor = draft.locator(".note-editor");
    await editor.fill("Ask after root answer");
    assert.equal(await draft.locator('[data-commit="ask"]').isDisabled(), true);
    const answeredRoot = session.nodes.get("root");
    answeredRoot.status = "answered";
    answeredRoot.markdown = "The root is now answered.";
    session.broadcast({ type: "node_answered", node_id: "root", parent_id: null, title: "Answered root",
      markdown: answeredRoot.markdown, origin: null, base_url: null, base_url_source: null });
    await page.waitForFunction(() => {
      const ask = document.querySelector('.node.note-draft [data-commit="ask"]');
      return ask && !ask.disabled;
    });
    assert.equal(await draft.locator('[data-commit="ask"]').isDisabled(), false,
      "node_answered must refresh and unlock an open standalone Ask draft");

    session.close("done");
    await page.waitForFunction(() => document.querySelector(".node.note-draft .note-editor")?.placeholder === "Session ended");
    assert.equal(await editor.getAttribute("placeholder"), "Session ended",
      "an uncommitted standalone draft must not claim it was saved when the session closes");
    console.log("ok enter composition: pending root Note/Ask lock, node_answered refresh, selected-text thumbnails, and honest closed copy");
  } finally {
    await context.close();
    await session.close("enter_composition_test_complete");
  }
}

async function openTestPage(streams) {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const state = { providerCalls: 0 };
  await routeProvider(page, {
    streams,
    providerDelayMs: 120,
    onProviderCall: () => { state.providerCalls += 1; },
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rabbitholeTest);
  return {
    context,
    page,
    get providerCalls() { return state.providerCalls; },
  };
}

async function verifyStartComposer(page, calls) {
  await page.click("#blank-start-new");
  await page.click("#composer-path-ask");
  await page.fill("#composer-input", "composing start");
  assert.equal((await dispatchComposingEnter(page, "#composer-input")).defaultPrevented, false);
  assert.equal(calls(), 0, "IME Enter must not submit the start composer");
  assert.equal(await page.locator("#composer-modal:not([hidden])").count(), 1);

  await page.fill("#composer-input", "line one");
  await page.focus("#composer-input");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue("#composer-input"), "line one\nline two", "Shift+Enter should insert a newline in the start composer");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rabbitholeTest?.currentHoleId?.());
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  assert.equal(calls(), 1, "plain Enter should submit the start composer once");
}

async function verifySelectionCommitKeys(page, calls) {
  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "composing selection");
  assert.equal((await dispatchComposingEnter(page, "#ask-text")).defaultPrevented, false);
  assert.equal(calls(), 0, "IME Enter must not submit the selection ask composer");
  assert.equal(await page.locator("#ask.visible").count(), 1);

  await page.fill("#ask-text", "line one");
  await page.focus("#ask-text");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue("#ask-text"), "line one\nline two", "Shift+Enter should insert a newline in the selection ask composer");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  await page.locator(".node:not(.root)", { hasText: "Selection Enter completed." }).waitFor();
  assert.equal(calls(), 1, "Cmd/Ctrl+Enter should submit the selection ask once");
}

async function verifyReaderComposer(page, calls) {
  await page.evaluate(() => document.querySelector(".node.current [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas"));
  await assertComposerAtRest(page, "#composer-actions",
    "an empty reader composer should rest on the four lenses with the commit pair hidden");
  await page.fill("#composer-text", "composing reader");
  assert.equal((await dispatchComposingEnter(page, "#composer-text")).defaultPrevented, false);
  assert.equal(calls(), 1, "IME Enter must not submit the reader follow-up composer");

  await page.fill("#composer-text", "");
  const blankCount = await page.locator(".node").count();
  await page.press("#composer-text", "Enter");
  await page.press("#composer-text", "Control+Enter");
  assert.equal(await page.locator(".node").count(), blankCount, "blank reader Enter variants must be inert");
  assert.equal(calls(), 1, "blank reader Enter variants must not call the provider");

  await page.fill("#composer-text", "line one");
  assert.equal(await page.locator("#composer-inner").evaluate((inner) => inner.classList.contains("has-draft")), true,
    "a reader draft should reveal the shared commit pair");
  await page.focus("#composer-text");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue("#composer-text"), "line one\nline two", "Shift+Enter should insert a newline in the reader follow-up composer");
  await page.keyboard.press("Enter");
  // A note about the document you are reading docks onto it: a ring in the
  // reader's own margin, never a card and never a branch tile.
  const readerRing = page.locator("#reader-main .note-dot.note-dot-whole").last();
  await readerRing.waitFor();
  const readerNoteId = await readerRing.getAttribute("data-note");
  assert.deepEqual(await storedNote(page, readerNoteId), { origin: { kind: "note" }, markdown: "line one\nline two", docked: true, size: null },
    "a reader Enter note should persist as a docked, place-less note");
  assert.equal(await page.locator(`#margin-notes .side-item[data-child="${readerNoteId}"]`).count(), 0,
    "a docked note is not a branch and must not take a rail tile");
  assert.equal(calls(), 1, "plain Enter should save a reader note without calling the provider");
  await page.waitForFunction(() => Array.from(document.querySelectorAll("#composer-actions .ask-commit"))
    .every((button) => getComputedStyle(button).display === "none"));

  await page.fill("#composer-text", "Reader command ask");
  await page.keyboard.press("Control+Enter");
  await page.locator("body", { hasText: "Reader Enter completed." }).waitFor();
  assert.equal(calls(), 2, "Cmd/Ctrl+Enter should submit the reader ask once");

  // Lenses live on follow-up composers too: an empty-box lens tap is a
  // whole-document ask with the canned lens question.
  await page.click('#composer-actions .lens[data-lens="explain"]');
  await page.locator("body", { hasText: "Reader lens completed." }).waitFor();
  assert.equal(calls(), 3, "an empty-box reader lens tap should submit one whole-document lens ask");
  await page.waitForFunction(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    return hole.nodes.some((node) => node.origin?.lens === "explain" && node.origin?.selected_text === "" && node.origin?.branch_type === "followup");
  });
}

async function verifyCardComposer(page, calls) {
  await page.evaluate(() => document.getElementById("reader-restore").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas"));
  await page.locator(".node.root .nc-handle").evaluate((button) => button.click());
  const selector = ".node.root .nc-inner textarea";
  await assertComposerAtRest(page, ".node.root .nc-inner .ask-actions",
    "an empty card composer should rest on the four lenses with the commit pair hidden");
  await page.fill(selector, "composing card");
  assert.equal((await dispatchComposingEnter(page, selector)).defaultPrevented, false);
  assert.equal(calls(), 3, "IME Enter must not submit the card follow-up composer");

  await page.fill(selector, "");
  const blankCount = await page.locator(".node").count();
  await page.press(selector, "Enter");
  await page.press(selector, "Control+Enter");
  assert.equal(await page.locator(".node").count(), blankCount, "blank card Enter variants must be inert");
  assert.equal(calls(), 3, "blank card Enter variants must not call the provider");

  await page.fill(selector, "   ");
  await page.press(selector, "1");
  assert.equal(await page.inputValue(selector), "   1", "a lens key must type normally unless the editor is exactly empty");
  await page.fill(selector, "   ");
  await page.locator('.node.root .nc-inner .lens[data-lens="explain"]').evaluate((button) => button.click());
  assert.equal(calls(), 3, "a lens click must be inert when the editor contains whitespace");
  await page.fill(selector, "");

  // Regression: a classList.toggle with an undefined force argument flips the
  // dim class on every input event — check two consecutive keystrokes so the
  // assertion cannot pass on flip parity.
  await page.focus(selector);
  await page.keyboard.type("a");
  const dimA = await page.locator(".node.root .nc-inner").evaluate((el) => el.classList.contains("disabled"));
  await page.keyboard.type("b");
  const dimB = await page.locator(".node.root .nc-inner").evaluate((el) => el.classList.contains("disabled"));
  assert.equal(dimA || dimB, false, "a live card composer must not dim while typing");
  await page.fill(selector, "");

  await page.fill(selector, "line one");
  await page.focus(selector);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue(selector), "line one\nline two", "Shift+Enter should insert a newline in the card follow-up composer");
  await page.keyboard.press("Enter");
  // The same on the canvas: the card composer's Note commit docks a whole-card
  // note onto the card it was written from.
  const cardRing = page.locator(".node.root .note-dot.note-dot-whole").last();
  await cardRing.waitFor();
  const cardNoteId = await cardRing.getAttribute("data-note");
  assert.deepEqual(await storedNote(page, cardNoteId), { origin: { kind: "note" }, markdown: "line one\nline two", docked: true, size: null },
    "card Enter should persist an anchor-less docked note with no canvas geometry");
  assert.equal(await page.locator(`.node[data-id="${cardNoteId}"]`).count(), 0, "a docked note has no card of its own");
  assert.equal(calls(), 3, "plain Enter should save a card note without calling the provider");

  await page.locator(".node.root .nc-handle").evaluate((button) => button.click());
  await page.fill(selector, "Card command ask");
  await page.keyboard.press("Control+Enter");
  await page.locator(".node:not(.root)", { hasText: "Card Enter completed." }).waitFor();
  assert.equal(calls(), 4, "Cmd/Ctrl+Enter should submit the card ask once");

  await page.locator(".node.root .nc-handle").evaluate((button) => button.click());
  await page.locator('.node.root .nc-inner .lens[data-lens="eli5"]').evaluate((button) => button.click());
  await page.locator(".node:not(.root)", { hasText: "Card lens completed." }).waitFor();
  assert.equal(calls(), 5, "an empty-box card lens tap should submit one whole-document lens ask");
}

async function verifyStandaloneComposer(page, calls) {
  let point = await findCanvasBackground(page);
  await page.mouse.dblclick(point.x, point.y);
  const selector = ".node.note-draft .note-editor";
  await page.waitForSelector(selector);
  const actionParity = await page.evaluate(() => {
    const signature = (root) => Array.from(root.querySelectorAll(".ask-commit")).map((button) => ({
      className: button.className,
      commit: button.dataset.commit,
      title: button.title,
      label: button.childNodes[0].textContent.trim(),
      hint: button.querySelector("kbd")?.textContent,
    }));
    return {
      card: signature(document.querySelector(".node.root .node-composer")),
      standalone: signature(document.querySelector(".node.note-draft .nc-inner")),
      standaloneLenses: document.querySelectorAll(".node.note-draft .lens").length,
      disabled: Array.from(document.querySelectorAll(".node.note-draft .ask-commit")).map((button) => button.disabled),
    };
  });
  assert.deepEqual(actionParity.standalone.map(({ title, hint, ...action }) => action),
    actionParity.card.map(({ title, hint, ...action }) => action),
    "standalone and card composers must keep the same Note/Ask action structure");
  assert.deepEqual(actionParity.card.map(({ title, hint }) => ({ title, hint })), [
    { title: "Save note (Enter)", hint: "↵" },
    { title: "Ask (Command/Control+Enter)", hint: "⌘↵" },
  ], "card composers must retain their existing Enter shortcuts");
  assert.deepEqual(actionParity.standalone.map(({ title, hint }) => ({ title, hint: hint || null })), [
    { title: "Save note (Command/Control+S)", hint: "⌘S" },
    { title: "Ask (Command/Control+Enter)", hint: "⌘↵" },
  ], "standalone drafts must advertise Note as Cmd/Ctrl+S and Ask as Cmd/Ctrl+Enter");
  assert.equal(actionParity.standaloneLenses, 0, "the root-level standalone composer must not expose document lenses");
  assert.deepEqual(actionParity.disabled, [true, true], "an empty standalone composer must disable both commit actions");

  await page.fill(selector, "composing standalone");
  assert.equal((await dispatchComposingEnter(page, selector)).defaultPrevented, false);
  assert.equal((await dispatchModifiedEnter(page, selector, { altKey: true })).defaultPrevented, false,
    "Alt+Enter must remain text input on the standalone surface, matching the card composer");
  assert.equal(calls(), 5, "IME and Alt+Enter must not submit the standalone composer");

  await page.fill(selector, "");
  const blankCount = await page.locator(".node").count();
  await page.press(selector, "Enter");
  await page.press(selector, "Control+Enter");
  assert.equal(await page.locator(".node").count(), blankCount, "blank standalone Enter variants must be inert");
  assert.equal(calls(), 5, "blank standalone Enter variants must not call the provider");

  await page.fill(selector, "line one");
  await page.focus(selector);
  await page.keyboard.press("Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue(selector), "line one\nline two",
    "plain Enter should insert a newline in the standalone composer");
  assert.equal(await page.locator(".node.note-draft").count(), 1,
    "plain Enter must leave the standalone draft uncommitted");
  assert.equal(calls(), 5, "plain Enter must not call the provider or commit the standalone draft");
  await page.keyboard.press("Control+Shift+Enter");
  await page.locator(".node-note", { hasText: "line one" }).last().waitFor();
  await page.waitForFunction(() => !document.querySelector(".node.note-draft"));
  assert.equal(calls(), 5, "the direct-placement chord should degrade to Note on a standalone window");

  point = await findCanvasBackground(page);
  await page.mouse.dblclick(point.x, point.y);
  await page.waitForSelector(selector);
  await page.fill(selector, "Standalone command ask");
  const draft = await page.locator(".node.note-draft").evaluate((card) => {
    card.__enterStandaloneIdentity = true;
    const rect = card.getBoundingClientRect();
    return {
      id: card.dataset.id,
      edgeCount: document.querySelectorAll("#edges path").length,
      transform: getComputedStyle(document.getElementById("world")).transform,
      position: { x: parseFloat(card.style.left), y: parseFloat(card.style.top) },
      size: { w: card.offsetWidth, h: card.offsetHeight },
      screen: { left: rect.left, top: rect.top, width: rect.width },
    };
  });
  await page.keyboard.press("Control+Enter");
  const askCard = page.locator(`.node[data-id="${draft.id}"]`);
  await page.waitForFunction((id) => {
    const card = document.querySelector(`.node[data-id="${id}"]`);
    return card && !card.classList.contains("note-draft") && card.textContent.includes("Thinking");
  }, draft.id);
  assert.deepEqual(await askCard.evaluate((card) => {
    const rect = card.getBoundingClientRect();
    return {
      sameCard: card.__enterStandaloneIdentity === true,
      edgeCount: document.querySelectorAll("#edges path").length,
      ownEdges: document.querySelectorAll(`#edges [data-child="${card.dataset.id}"]`).length,
      transform: getComputedStyle(document.getElementById("world")).transform,
      screen: { left: rect.left, top: rect.top, width: rect.width },
    };
  }), {
    sameCard: true,
    edgeCount: draft.edgeCount,
    ownEdges: 0,
    transform: draft.transform,
    screen: draft.screen,
  }, "Cmd/Ctrl+Enter must morph the draft into a disconnected pending card without moving the viewport");
  await page.waitForFunction(async ({ id, position, size }) => {
    const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
    return node?.status === "pending" && node.parent_id === null
      && node.position.x === position.x && node.position.y === position.y
      && node.size.w === size.w && node.size.h === size.h;
  }, { id: draft.id, position: draft.position, size: draft.size });
  await askCard.filter({ hasText: "Standalone composer ask completed." }).waitFor();
  assert.equal(calls(), 6, "Cmd/Ctrl+Enter should submit the standalone Ask once");
  assert.deepEqual(await askCard.evaluate((card) => ({
    sameCard: card.__enterStandaloneIdentity === true,
    edgeCount: document.querySelectorAll("#edges path").length,
    ownEdges: document.querySelectorAll(`#edges [data-child="${card.dataset.id}"]`).length,
    transform: getComputedStyle(document.getElementById("world")).transform,
  })), { sameCard: true, edgeCount: draft.edgeCount, ownEdges: 0, transform: draft.transform },
  "the answer stream must settle into the exact same disconnected card");
  await page.waitForFunction(async ({ id, position, size }) => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    return hole.nodes.some((node) => node.id === id && node.parent_id === null
      && node.origin?.question === "Standalone command ask"
      && node.origin?.selected_text === "" && node.origin?.branch_type === "followup"
      && node.position.x === position.x && node.position.y === position.y
      && node.size.w === size.w && node.size.h === size.h);
  }, { id: draft.id, position: draft.position, size: draft.size });
}

async function assertComposerAtRest(page, selector, message) {
  assert.deepEqual(await page.locator(selector).evaluate((row) => ({
    lensesVisible: Array.from(row.querySelectorAll(".lens")).every((button) => getComputedStyle(button).display !== "none"),
    commitsHidden: Array.from(row.querySelectorAll(".ask-commit")).every((button) => getComputedStyle(button).display === "none"),
  })), { lensesVisible: true, commitsHidden: true }, message);
}

async function dispatchComposingEnter(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    const allowed = element.dispatchEvent(event);
    return { allowed, defaultPrevented: event.defaultPrevented };
  });
}

async function dispatchModifiedEnter(page, selector, modifiers) {
  return page.locator(selector).evaluate((element, values) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...values,
    });
    const allowed = element.dispatchEvent(event);
    return { allowed, defaultPrevented: event.defaultPrevented };
  }, modifiers);
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rabbitholeTest?.currentHoleId?.() || "");
  await page.evaluate((value) => window.__rabbitholeTest.createDocument(value), markdown);
  await page.waitForFunction((oldId) => {
    const id = window.__rabbitholeTest?.currentHoleId?.();
    return id && id !== oldId && document.querySelector(".doc-content");
  }, previous);
  return page.evaluate(() => window.__rabbitholeTest.currentHoleId());
}

async function selectText(page, text) {
  await page.evaluate((targetText) => {
    const root = document.querySelector(".node .doc-content[data-node-id]");
    if (!root) throw new Error("No document content to select");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.nodeValue.indexOf(targetText);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + targetText.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 120, clientY: 160 }));
      return;
    }
    throw new Error(`Text not found: ${targetText}`);
  }, text);
}

async function findCanvasBackground(page) {
  return page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    for (let y = innerHeight - 70; y >= 90; y -= 70) {
      for (let x = innerWidth - 70; x >= 70; x -= 70) {
        const target = document.elementFromPoint(x, y);
        if (target && viewport.contains(target) && !target.closest(".node")) return { x, y };
      }
    }
    throw new Error("No empty canvas point found");
  });
}

/* The persisted shape of one note. Polled rather than waited on: Playwright's
   waitForFunction resolves on a returned Promise instead of its value. */
async function storedNote(page, id, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let node = null;
  while (Date.now() < deadline) {
    node = await page.evaluate(async (noteId) =>
      (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === noteId) || null, id);
    if (node) return { origin: node.origin, markdown: node.markdown, docked: node.extensions?.note?.docked ?? false, size: node.size };
    await page.waitForTimeout(120);
  }
  throw new Error(`note ${id} never persisted`);
}
