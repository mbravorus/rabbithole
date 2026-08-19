import {
  CANVAS_BASE,
  buildDocContent,
  canvasBuilt,
  childrenOf,
  closed,
  currentNodeId,
  flashHint,
  fontPx,
  frozen,
  goToNode,
  mode,
  nextOrder,
  nodes,
  playLandingCue,
  postBrowserEvent,
  readerMain,
  registerNode,
  shouldReduceMotion,
  uuid,
  view,
  world
} from "./core.js";
import { DEFAULT_CHILD, nodeOrder, placeChild as sharedPlaceChild } from "../core/layout.js";
import { BRANCH_SELECTION, branchTypeOfNode, isDockedNote } from "../core/model.js";
import {
  autoGrowEl,
  canConvertNote,
  cancelViewAnimation,
  convertNoteToAsk,
  createNodeEl,
  drawEdges,
  effH,
  noteCommitFromEnter,
  noteComposerActions,
  renderVisibility,
  scheduleEdges
} from "./canvas-view.js";
import { renderMarginNotes } from "./reader.js";
import { removeBranch } from "./branch-surfaces.js";
import { mountPdfRectMark, syncTextOverlayMarks, wrapInContainer } from "./text-marks.js";
import { wireComposerActions } from "./composer-state.js";
import { openPopover } from "./primitives/popover.js";
import { createModuleLifecycle } from "./lifecycle.js";
import { refreshNodeHtml } from "./renderer.js";
import { teardownNode } from "./node-teardown.js";

/*
 * DOCKED NOTES — a note written about a card stays on that card.
 *
 * Nothing here is a new kind of thing: a docked note is an ordinary note node
 * whose extensions bag says it has no place on the canvas yet. It renders as
 * the wash on the words it marks plus a graphite dot in the card's own right
 * padding, and it reads and edits inside one anchored dialog. "Place on canvas"
 * clears the flag and hands the same node a position — same id, same lineage,
 * same MCP payload; only its shape on the page ever changed.
 *
 * The grammar is the product's existing one: single click reads, double click
 * edits — on the wash, on the dot, or on the note's own text in the popover.
 */

// The read view clamps at 264px including its 16px block padding (styles.js
// .note-pop-view); the textarea wears the same 248px content ceiling so a long
// note keeps one popover height across read and edit.
var NOTE_POP_EDITOR_MAX = 248;

var DOT_STACK_GAP = 14;   // minimum vertical rhythm between two dots
var DOT_RADIUS = 3.5;
var WHOLE_CARD_TOP = 2;   // the ring leads the column, level with the first line

var dockedLifecycle = createModuleLifecycle({ defaults: function(){ return {}; } });
// One popover, one open note. Everything the surface needs to answer for
// itself — which note, which card, which state — lives in this record.
var popSession = null;

export function initDockedNotes(){
  disposeDockedNoteResources(false);
  var scope = dockedLifecycle.beginInit();
  try {
    [world, readerMain].forEach(function(surface){
      scope.listen(surface, "click", onSurfaceClick);
      scope.listen(surface, "dblclick", onSurfaceDblClick);
      scope.listen(surface, "keydown", onSurfaceKeydown);
      scope.listen(surface, "mouseover", function(e){ syncPartnerHighlight(e, true); });
      scope.listen(surface, "mouseout", function(e){ syncPartnerHighlight(e, false); });
      // A card's own body carries its dots along as it scrolls, but an inner
      // scroller (a native PDF) moves the marks underneath them. Scroll does
      // not bubble, so the reposition is caught on the way down.
      scope.listen(surface, "scroll", scheduleEdges, true);
    });
    // Reader line breaks can change with the viewport. Repaint the empty note
    // overlays and move their dots after that reflow; neither pass can affect
    // the prose that caused it.
    scope.listen(window, "resize", positionDockedNotes);
    var surface = popEl();
    scope.listen(surface, "click", onPopoverClick);
    scope.listen(surface, "dblclick", onPopoverDblClick);
    scope.listen(surface, "keydown", onPopoverKeydown);
    scope.addCleanup(function(){ closeNotePopover({ restoreFocus: false, commit: false }); });
    return disposeDockedNotes;
  } catch (error) {
    disposeDockedNotes();
    throw error;
  }
}

export function disposeDockedNotes(){
  disposeDockedNoteResources(true);
}

function disposeDockedNoteResources(resetHooks){
  closeNotePopover({ restoreFocus: false, commit: false });
  dockedLifecycle.dispose(resetHooks);
  popSession = null;
}

function popEl(){ return document.getElementById("notepop"); }

// ---------------------------------------------------------------------------
// THE MODEL SIDE — creating, placing, removing
// ---------------------------------------------------------------------------

/* One optimistic note path serves anchored selection notes and anchor-less
   whole-card notes. The anchor alone decides whether there is a wash to mark;
   the durable origin stays the reducer's canonical {kind:"note"}. */
function createNoteChild(parent, markdown, options){
  options = options || {};
  markdown = String(markdown || "").trim();
  if (!parent || !markdown || closed || parent.extensions?.pdf?.converting) return null;
  var anchor = options.anchor || null;
  var placed = options.placed === true;
  var origin = anchor
    ? { kind: "note", selected_text: options.selectedText || "", anchor: anchor, branch_type: BRANCH_SELECTION }
    : { kind: "note" };
  var node = {
    id: uuid(), parent_id: parent.id, title: "Note", html: "", md: markdown,
    base_url: null, base_url_source: null, read: true, origin: origin,
    x: 0, y: 0, w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
    status: "answered", _order: nextOrder(), _startTs: 0,
    extensions: placed ? {} : { note: { docked: true } }
  };
  if (placed){
    var pos = placeNoteChild(parent, branchTypeOfNode(node));
    node.x = pos.x; node.y = pos.y;
  }
  registerNode(node);
  paintNoteMarks(parent, node, anchor);
  if (placed) presentPlacedNote(node, parent, options.sourceRect);
  else {
    renderDockedNotes(parent);
    scheduleEdges();
    if (mode === "reader" && currentNodeId === parent.id) renderMarginNotes();
  }
  var payload = placed
    ? { type: "node_create", id: node.id, parent_id: parent.id, markdown: markdown, origin: origin,
      position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } }
    : { type: "node_create", id: node.id, parent_id: parent.id, markdown: markdown, origin: origin, docked: true };
  postBrowserEvent(payload).then(function(res){ if (!res || !res.ok) rollbackCreatedNote(node); });
  return node;
}

export function createDockedNote(parent, markdown, options){
  return createNoteChild(parent, markdown, options);
}

export function createPlacedNote(parent, markdown, options){
  return createNoteChild(parent, markdown, Object.assign({}, options, { placed: true }));
}

function paintNoteMarks(parent, node, anchor){
  if (!anchor) return;
  var readerDoc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
  var cardDoc = parent.bodyEl ? parent.bodyEl.querySelector(".doc-content") : null;
  if (anchor.pdf){
    if (mode === "reader") mountPdfRectMark(readerDoc, anchor, node.id, "rh-pdf-mark mark-ready mark-note");
    mountPdfRectMark(cardDoc, anchor, node.id, "rh-pdf-mark mark-ready mark-note");
    return;
  }
  if (mode === "reader") wrapInContainer(readerDoc, anchor, node.id, "hl mark-ready mark-note");
  wrapInContainer(cardDoc, anchor, node.id, "hl mark-ready mark-note");
}

function rollbackCreatedNote(node){
  if (nodes[node.id] !== node) return;
  var parent = nodes[node.parent_id];
  teardownNode(node.id);
  renderDockedNotes(parent);
  if (canvasBuilt) drawEdges();
  if (mode === "reader" && currentNodeId === node.parent_id) renderMarginNotes();
  flashHint("Couldn't save that note — it was undone.");
}

/* Placement is spatial, never a change of identity: the note keeps its id and
   its words and gains a position, using the same free-spot search a new branch
   uses. Docked siblings are invisible to that search — they have no place to
   collide with. */
function placeNoteChild(parent, branchType){
  return sharedPlaceChild(parent, branchType, {
    childrenOf: placedChildrenOf,
    effH: effH,
    sort: nodeOrder,
    childSize: DEFAULT_CHILD
  });
}

/** Children that actually occupy canvas space. */
export function placedChildrenOf(id){
  return childrenOf(id).filter(function(node){ return !isDockedNote(node); });
}

function presentPlacedNote(node, parent, sourceRect){
  if (canvasBuilt && !node.el) createNodeEl(node, false);
  renderVisibility();
  renderDockedNotes(parent);
  drawEdges();
  if (mode === "reader" && currentNodeId === parent.id) renderMarginNotes();
  flyNoteToCard(sourceRect, node);
}

export function placeDockedNote(node, sourceRect){
  var parent = node && node.parent_id != null ? nodes[node.parent_id] : null;
  if (!parent || frozen || closed || !isDockedNote(node)) return false;
  var pos = placeNoteChild(parent, branchTypeOfNode(node));
  node.x = pos.x; node.y = pos.y;
  node.extensions = Object.assign({}, node.extensions);
  delete node.extensions.note;
  presentPlacedNote(node, parent, sourceRect);
  postBrowserEvent({ type: "node_extensions_patch", node_id: node.id, namespace: "note", value: {} });
  postBrowserEvent({ type: "node_update", node_id: node.id,
    position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } });
  return true;
}

// The one moment a note travels: a FLIP on the real card. The card is created
// at its destination, an initial transform maps it back onto the dot or dialog
// it came from, and one composited transition carries it to identity — no
// ghost, no per-frame layout, no second copy of the text.
function flyNoteToCard(sourceRect, node){
  var card = node.el;
  if (!card) return;
  if (mode !== "canvas" || !sourceRect || document.hidden || shouldReduceMotion()){
    playLandingCue(card, "flash");
    return;
  }
  var target = card.getBoundingClientRect();
  if (!target.width || !target.height){ playLandingCue(card, "flash"); return; }
  // The card lives in the zoomed world, so screen deltas divide by the camera.
  var scale = view.scale || 1;
  var dx = (sourceRect.left - target.left) / scale;
  var dy = (sourceRect.top - target.top) / scale;
  var sx = Math.max(0.05, sourceRect.width / target.width);
  var sy = Math.max(0.05, sourceRect.height / target.height);
  card.style.transformOrigin = "top left";
  card.style.transform = "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")";
  card.style.opacity = "0.05";
  card.style.willChange = "transform, opacity";
  var scope = dockedLifecycle.scope;
  var settled = false;
  function settle(){
    if (settled) return;
    settled = true;
    card.removeEventListener("transitionend", onTransitionEnd);
    card.style.transition = "";
    card.style.transform = "";
    card.style.opacity = "";
    card.style.willChange = "";
    card.style.transformOrigin = "";
  }
  function onTransitionEnd(e){
    if (e.target === card && e.propertyName === "transform") settle();
  }
  function launch(){
    if (!card.isConnected){ settle(); return; }
    card.style.transition = "transform var(--duration-slow) var(--ease-out), opacity var(--duration-slow) var(--ease-out)";
    card.style.transform = "";
    card.style.opacity = "";
    card.addEventListener("transitionend", onTransitionEnd);
    if (scope) scope.timeout(settle, 520); else setTimeout(settle, 520);
  }
  if (scope) scope.raf(launch); else requestAnimationFrame(launch);
}

// ---------------------------------------------------------------------------
// THE MARGIN — dots that live in the card's own right padding
// ---------------------------------------------------------------------------

function noteAnchorOf(node){ return (node.origin && node.origin.anchor) || null; }

/* Whole-card notes lead the column; anchored notes follow in document order. */
function dockedNotesOf(parent){
  return childrenOf(parent.id).filter(isDockedNote).sort(function(a, b){
    var aAnchor = noteAnchorOf(a), bAnchor = noteAnchorOf(b);
    if (!aAnchor !== !bAnchor) return aAnchor ? 1 : -1;
    if (aAnchor && bAnchor) return aAnchor.offset_start - bAnchor.offset_start;
    return nodeOrder(a, b);
  });
}

function dotLabel(node){
  var words = String(node.md || "").replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  return noteAnchorOf(node) ? "Note: " + (words || "empty") : "Note on this card";
}

function canvasDotHost(parent){
  return parent.el && !parent.collapsed ? parent.bodyEl : null;
}
function readerDotHost(parent){
  return mode === "reader" && currentNodeId === parent.id ? readerMain.querySelector(".reader-col") : null;
}

/* Rebuild both dot columns for one card. Cheap enough to call from every place
   that rebuilds the card's body; positioning is a separate, measure-only pass
   because the card's width is only final after layout. */
export function renderDockedNotes(parent){
  if (!parent) return;
  var notes = dockedNotesOf(parent);
  syncDotColumn(canvasDotHost(parent), notes, false);
  syncDotColumn(readerDotHost(parent), notes, true);
  positionDockedNotes();
  if (dockedLifecycle.scope) dockedLifecycle.scope.raf(positionDockedNotes);
}

function syncDotColumn(host, notes, reader){
  if (!host) return;
  var layer = host.querySelector(":scope > .note-dots");
  if (!notes.length){
    if (layer) layer.remove();
    return;
  }
  if (!layer){
    layer = document.createElement("div");
    layer.className = "note-dots";
    host.appendChild(layer);
  }
  layer.classList.toggle("note-dots-reader", !!reader);
  // Dots keep their identity across re-renders: an open popover is anchored to
  // its dot element, so a rebuild must update in place, never replace. A
  // destroyed trigger would strand the dialog — anchoring bails on a
  // disconnected anchor and never recovers.
  var existing = {};
  for (var i = layer.children.length - 1; i >= 0; i--){
    var child = layer.children[i];
    existing[child.dataset.note] = child;
  }
  notes.forEach(function(note, index){
    var dot = existing[note.id];
    if (!dot){
      dot = document.createElement("button");
      dot.type = "button";
      dot.dataset.note = note.id;
      dot.setAttribute("aria-haspopup", "dialog");
      dot.setAttribute("aria-expanded", "false");
    }
    dot.className = "note-dot" + (noteAnchorOf(note) ? "" : " note-dot-whole");
    dot.setAttribute("aria-label", dotLabel(note));
    if (layer.children[index] !== dot) layer.insertBefore(dot, layer.children[index] || null);
  });
  // Every wanted dot now sits at its own index; anything beyond them is stale.
  while (layer.children.length > notes.length) layer.lastChild.remove();
}

/* Each dot sits on its anchor's line box, nudging off the exact line only when
   a neighbour is already there. Canvas rects arrive scaled by the camera; the
   column's own coordinates never are. */
export function positionDockedNotes(){
  syncTextOverlayMarks(document);
  var layers = document.querySelectorAll(".note-dots");
  for (var i = 0; i < layers.length; i++) positionDotColumn(layers[i]);
}

function positionDotColumn(layer){
  var host = layer.parentElement;
  var reader = layer.classList.contains("note-dots-reader");
  // The reader keeps its DOM while the canvas is up, but its margin column
  // belongs to the document being read: it retires with the mode.
  if (!host || (reader && mode !== "reader")){ layer.remove(); return; }
  var scale = reader ? 1 : (view.scale || 1);
  var hostRect = host.getBoundingClientRect();
  var scrollTop = reader ? 0 : host.scrollTop;
  // The reader's margin is only a margin while there is room for it; a column
  // that fills the window (a native PDF) keeps its dots inside its own edge.
  if (reader) layer.classList.toggle("note-dots-inside", hostRect.right + 26 > (window.innerWidth || 0));
  var previous = -Infinity;
  var dots = layer.children;
  for (var i = 0; i < dots.length; i++){
    var dot = dots[i];
    var mark = markElement(host, dot.dataset.note);
    var markRect = mark ? mark.getBoundingClientRect() : null;
    var top = markRect && markRect.height
      ? (markRect.top - hostRect.top) / scale + scrollTop + (markRect.height / scale) / 2 - DOT_RADIUS
      : WHOLE_CARD_TOP;
    if (top < previous + DOT_STACK_GAP) top = previous + DOT_STACK_GAP;
    previous = top;
    dot.style.top = top + "px";
  }
}

function markElement(scope, noteId){
  if (!scope || !noteId) return null;
  return scope.querySelector('mark[data-child="' + noteId + '"], [data-child="' + noteId + '"].rh-pdf-mark');
}

function visibleElement(selector){
  var found = document.querySelectorAll(selector);
  for (var i = 0; i < found.length; i++){
    if (found[i].isConnected && found[i].getClientRects().length) return found[i];
  }
  return found[0] || null;
}

function affordanceFor(node){
  return visibleElement('.note-dot[data-note="' + node.id + '"]')
    || visibleElement('mark[data-child="' + node.id + '"], [data-child="' + node.id + '"].rh-pdf-mark');
}

// Hovering either half of a note lights the other: the wash and its dot are one
// object seen twice.
function syncPartnerHighlight(event, on){
  var target = event.target;
  if (!target || !target.closest) return;
  var dot = target.closest(".note-dot");
  if (dot){
    if (!on && dot.contains(event.relatedTarget)) return;
    setMarkHighlight(dot.dataset.note, on);
    return;
  }
  var mark = target.closest("[data-child]");
  if (!mark || !isDockedNote(nodes[mark.dataset.child])) return;
  if (!on && mark.contains(event.relatedTarget)) return;
  var partner = visibleElement('.note-dot[data-note="' + mark.dataset.child + '"]');
  if (partner) partner.classList.toggle("note-dot-partner", on);
}

function setMarkHighlight(noteId, on){
  var marks = document.querySelectorAll('[data-child="' + noteId + '"]');
  for (var i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
}

// ---------------------------------------------------------------------------
// GESTURES — click reads, double click edits, wherever the note shows itself
// ---------------------------------------------------------------------------

function dockedNoteFromEvent(event){
  var target = event.target;
  if (!target || !target.closest) return null;
  var dot = target.closest(".note-dot");
  if (dot) return { node: nodes[dot.dataset.note], trigger: dot, placement: "bottom-end" };
  var mark = target.closest("[data-child]");
  if (!mark) return null;
  var node = nodes[mark.dataset.child];
  return isDockedNote(node) ? { node: node, trigger: mark, placement: "bottom-start" } : null;
}

function onSurfaceClick(event){
  var hit = dockedNoteFromEvent(event);
  if (!hit || !hit.node) return;
  if (!window.getSelection().isCollapsed) return; // the human was selecting, not clicking
  event.preventDefault();
  event.stopPropagation();
  openDockedNote(hit.node, hit.trigger, "read", hit.placement);
}

function onSurfaceDblClick(event){
  var hit = dockedNoteFromEvent(event);
  if (!hit || !hit.node) return;
  event.preventDefault();
  event.stopPropagation();
  openDockedNote(hit.node, hit.trigger, editingAllowed() ? "edit" : "read", hit.placement);
}

function onSurfaceKeydown(event){
  if (event.key !== "Enter" && event.key !== "F2") return;
  var hit = dockedNoteFromEvent(event);
  if (!hit || !hit.node) return;
  event.preventDefault();
  event.stopPropagation();
  var wantsEdit = event.key === "F2" || (popSession && popSession.node === hit.node);
  openDockedNote(hit.node, hit.trigger, wantsEdit && editingAllowed() ? "edit" : "read", hit.placement);
}

function editingAllowed(){ return !frozen && !closed; }

// ---------------------------------------------------------------------------
// THE POPOVER — read state, edit state, one anchored dialog
// ---------------------------------------------------------------------------

/** Open a note the human already has on screen (dot, wash, or ⌘K result). */
export function openDockedNote(node, trigger, state, placement){
  if (!node) return;
  // No affordance, no dialog: a popover must never anchor to itself.
  var anchor = trigger || affordanceFor(node);
  if (!anchor) return;
  openNotePopover({
    node: node,
    trigger: anchor,
    state: state === "edit" && editingAllowed() ? "edit" : "read",
    placement: placement
  });
}

/* A ⌘K hit on a docked note: it has no card of its own, so travel to the card
   it lives on and open it there. */
export function revealDockedNote(node, source){
  if (!isDockedNote(node)) return false;
  var parent = nodes[node.parent_id];
  if (!parent) return false;
  function show(){
    var affordance = affordanceFor(node);
    if (affordance) openDockedNote(node, affordance, "read");
  }
  if (affordanceFor(node)){ show(); return true; }
  goToNode(parent, source);
  if (dockedLifecycle.scope) dockedLifecycle.scope.raf(show); else show();
  return true;
}

export function closeDockedNotePopover(settings){
  closeNotePopover(settings || { restoreFocus: false, commit: true });
}

function openNotePopover(options){
  var surface = popEl();
  if (!surface || !options.trigger) return;
  closeNotePopover({ restoreFocus: false, commit: true });
  // The dialog is pinned to a card's screen rect and applyTransform dismisses
  // anything anchored there, so an in-flight glide would close it on its very
  // next frame. Reaching for a note yields the glide, exactly as the ⋯ menu does.
  cancelViewAnimation();
  popSession = { node: options.node, trigger: options.trigger,
    state: "read", editor: null, popover: null, readFooter: null };
  // Visible before its contents: a textarea inside a hidden surface cannot take
  // focus, and the editor claims the caret in the same frame it appears.
  surface.classList.add("visible");
  renderPopoverState(options.state === "edit" ? "edit" : "read");
  popSession.popover = openPopover({
    trigger: options.trigger,
    surface: surface,
    placement: options.placement || "bottom-end",
    // Escape walks one level at a time here (edit → read → closed), so the
    // layer stack must not swallow the whole dialog on the first press.
    closeOnEscape: false,
    onEscape: onPopoverEscape,
    initialFocus: popSession.editor || surface.querySelector(".note-pop-view"),
    onClose: function(){ closeNotePopover({ commit: true }); }
  });
}

function closeNotePopover(settings){
  var session = popSession;
  if (!session) return;
  popSession = null;
  settings = settings || {};
  if (settings.commit !== false && session.state === "edit") commitEditor(session, "close");
  var surface = popEl();
  if (surface){
    surface.classList.remove("visible");
    surface.querySelector(".note-pop-body").replaceChildren();
    // The edit state borrowed the footer's slot for the commit pair; hand the
    // read bar back so the next open starts from the surface's own markup.
    if (session.readFooter) surface.querySelector(".note-pop-actions").replaceWith(session.readFooter);
  }
  if (session.popover) session.popover.close(settings);
}

function renderPopoverState(state){
  var session = popSession, surface = popEl();
  if (!session || !surface) return;
  session.state = state;
  session.editor = null;
  var body = surface.querySelector(".note-pop-body");
  var footer = surface.querySelector(".note-pop-actions");
  if (state === "edit"){
    // One footer bar, constant geometry: the read bar lends its slot to the
    // composer's commit pair and takes it back on the way out.
    var editor = buildNoteEditor(session);
    if (!session.readFooter){ session.readFooter = footer; }
    footer.replaceWith(editor.actions);
    body.replaceChildren(editor.input);
    // Sized and focused only once it is in the document: height needs layout
    // and focus needs a visible box.
    autoGrowEl(session.editor, NOTE_POP_EDITOR_MAX);
    session.editor.focus({ preventScroll: true });
    session.editor.setSelectionRange(session.editor.value.length, session.editor.value.length);
    return;
  }
  if (session.readFooter && footer !== session.readFooter){
    footer.replaceWith(session.readFooter);
    footer = session.readFooter;
  }
  session.readFooter = null;
  var view = document.createElement("div");
  view.className = "note-pop-view";
  view.title = editingAllowed() ? "Double-click to edit" : "";
  view.tabIndex = 0;
  view.appendChild(buildDocContent(session.node, CANVAS_BASE));
  body.replaceChildren(view);
  // A snapshot reads and nothing more — the whole bar stands down with its verbs.
  footer.style.display = editingAllowed() ? "" : "none";
  surface.querySelector(".note-pop-place").style.display = isDockedNote(session.node) ? "" : "none";
}

/* The edit state is the read state with a caret — same inset, same face — and
   the composer's own bar: the same Note / Ask pair, the same keys, because a
   note being written for the first time and a note being rewritten are the
   same act. */
function buildNoteEditor(session){
  var input = document.createElement("div");
  input.className = "ask-input";
  var editor = document.createElement("textarea");
  editor.className = "note-editor md";
  editor.rows = 1;
  editor.spellcheck = true;
  editor.setAttribute("aria-label", "Edit note");
  editor.value = session.node.md || "";
  // The editor is the prose it replaces, including whatever the reading-size
  // preference and the note's own scale make that prose.
  editor.style.fontSize = fontPx(CANVAS_BASE, session.node.font_scale) + "px";
  var actions = noteComposerActions();
  actions.classList.add("note-pop-actions", "has-draft");
  // A note that cannot become an ask keeps the bar with Note alone — one
  // button, so no divider down the middle.
  if (!canAskFromNote(session)){
    actions.querySelector('[data-commit="ask"]').remove();
    actions.classList.add("note-only");
  }
  input.appendChild(editor);
  session.editor = editor;
  function syncCommits(){
    var disabled = !editor.value.trim();
    var commits = actions.querySelectorAll(".ask-commit");
    for (var i = 0; i < commits.length; i++) commits[i].disabled = disabled;
  }
  editor.addEventListener("input", function(){ autoGrowEl(editor, NOTE_POP_EDITOR_MAX); syncCommits(); });
  wireComposerActions({ text: editor, actions: actions,
    hasDraft: function(){ return !!editor.value.trim(); },
    // The note editor's Enter contract everywhere: Enter is a newline, ⌘↵ asks,
    // ⌘S saves (wired centrally by wireComposerActions).
    commitFromEnter: noteCommitFromEnter,
    onCommit: function(kind, e){ e.stopPropagation(); commitEditor(popSession, kind); },
    onLens: function(){} });
  syncCommits();
  return { input: input, actions: actions };
}

/* Asking from a docked note is one motion: the note gains a place and then
   becomes the question, so the answer has something to hang from. */
function canAskFromNote(session){
  return editingAllowed() && canConvertNote(session.node);
}

function commitEditor(session, kind){
  if (!session || session.state !== "edit" || !session.editor) return;
  var text = session.editor.value.trim();
  var node = session.node;
  if (!text){
    // An empty note is no note: the note keeps the words it already had.
    if (kind !== "close") renderPopoverState("read");
    return;
  }
  if (text !== (node.md || "")){
    node.md = text;
    refreshNodeHtml(node);
    persistNoteText(node);
    renderDockedNotes(nodes[node.parent_id]);
  }
  if (kind === "ask" && placeDockedNote(node, affordanceRect(node)) && convertNoteToAsk(node, text)){
    closeNotePopover({ commit: false });
    return;
  }
  if (kind === "note-window" && placeDockedNote(node, affordanceRect(node))){
    closeNotePopover({ restoreFocus: false, commit: false });
    return;
  }
  if (kind === "close"){
    session.state = "read";
    return;
  }
  // Saving re-renders in place to the read state — you see what you wrote,
  // in the same dialog, with nothing torn down to blink or jump.
  renderPopoverState("read");
  if (session.popover) session.popover.update();
  focusPopover();
}

function persistNoteText(node){
  postBrowserEvent({ type: "node_update", node_id: node.id, title: node.title, markdown: node.md });
}

/* A keyboard save (or Escape out of the editor) puts focus on the dialog
   surface, not the prose: the surface keeps every popover shortcut alive —
   Esc, ⌫, ⌘↵, double-click — but wears no focus ring by design, so the note
   never comes back from a save outlined. */
function focusPopover(){
  var surface = popEl();
  if (!surface) return;
  try { surface.focus({ preventScroll: true }); } catch(_e){}
}

function affordanceRect(node){
  var affordance = affordanceFor(node);
  return affordance ? affordance.getBoundingClientRect() : null;
}

function placePopoverNote(session){
  var node = session && session.node, rect = affordanceRect(node);
  if (!node || !isDockedNote(node)) return;
  closeNotePopover({ restoreFocus: false, commit: false });
  placeDockedNote(node, rect);
}

function deletePopoverNote(session){
  var doomed = session && session.node;
  if (!doomed) return;
  closeNotePopover({ restoreFocus: false, commit: false });
  removeBranch(doomed);
  renderDockedNotes(nodes[doomed.parent_id]);
}

function onPopoverClick(event){
  var session = popSession;
  var button = event.target.closest ? event.target.closest("button") : null;
  if (!session || !button) return;
  if (button.classList.contains("note-pop-place")){
    event.stopPropagation();
    placePopoverNote(session);
  } else if (button.classList.contains("note-pop-delete")){
    event.stopPropagation();
    deletePopoverNote(session);
  }
}

function onPopoverKeydown(event){
  var session = popSession, surface = popEl();
  if (!session || session.state !== "read" || !surface.contains(document.activeElement) || !editingAllowed()) return;
  var commandEnter = event.key === "Enter" && (event.metaKey || event.ctrlKey)
    && !event.altKey && !event.shiftKey && !event.isComposing;
  var deleteKey = (event.key === "Backspace" || event.key === "Delete")
    && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (!commandEnter && !deleteKey) return;
  event.preventDefault();
  event.stopPropagation();
  if (commandEnter) placePopoverNote(session);
  else deletePopoverNote(session);
}

function onPopoverDblClick(event){
  if (!popSession || popSession.state === "edit" || !editingAllowed()) return;
  if (!event.target.closest || !event.target.closest(".note-pop-view")) return;
  event.preventDefault();
  event.stopPropagation();
  renderPopoverState("edit");
}

/* Escape gives back one level at a time: an edit reverts to the note as saved,
   the read state closes the dialog. */
function onPopoverEscape(){
  if (!popSession) return;
  if (popSession.state === "edit"){
    renderPopoverState("read");
    focusPopover();
    return;
  }
  closeNotePopover({ commit: false });
}
