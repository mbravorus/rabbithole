import {
  CANVAS_BASE,
  MAX_SCALE,
  MIN_SCALE,
  READER_BASE,
  SVGNS,
  buildDocContent,
  canvasBuilt,
  canvasFramed,
  changeNodeFontScale,
  childrenOf,
  closed,
  currentNodeId,
  deleteAsset,
  edgesSvg,
  flashHint,
  frozen,
  isVisible,
  mode,
  motionSourceFromEvent,
  nextOrder,
  nodes,
  playLandingCue,
  postBrowserEvent,
  putAsset,
  readerMain,
  registerCoreHooks,
  registerNode,
  rootId,
  resetNodeFontScale,
  setCanvasBuilt,
  setCanvasFramed,
  setModeValue,
  setViewAdjusted,
  shouldReduceMotion,
  sessionPhase,
  view,
  viewport,
  world,
  uuid,
  zoomLabel
} from "./core.js";
import {
  DEFAULT_CHILD,
  DEFAULT_STANDALONE_NOTE,
  TREE_PARENT_GAP,
  TREE_STACK_GAP,
  boundsOverlap,
  nodeBounds,
  nodeOrder,
  shiftBounds,
  unionBounds
} from "../core/layout.js";
import {
  BRANCH_FOLLOWUP,
  BRANCH_SELECTION,
  LENSES,
  branchTypeOfNode,
  isDockedNote,
  isNoteNode,
  lensLabel,
  truncate
} from "../core/model.js";
import { extractNodeAssetRefs } from "../core/assets.js";
import { openNode } from "./reader.js";
import { flyReaderToRect } from "./mode-transition.js";
import { applyChildHighlights, setNoteMarks, setPendingMarks, transitionMarkGroups } from "./text-marks.js";
import { easeInOutMotion, easeOutMotion } from "./easing.js";
import { composerActionsMarkup, iconButtonMarkup } from "../core/html/button-markup.js";
import { buildOriginCrop } from "./origin-provenance.js";
import { BUNNY_MARK_SVG, iconSvg } from "../core/html/icons.js";
import { createCleanupScope, createModuleLifecycle } from "./lifecycle.js";
import { captureContentPosition, restoreContentPosition } from "./scroll-position.js";
import { applyComposerState, wireComposerActions } from "./composer-state.js";
import { isCommandEnter } from "./input-intent.js";
import { refreshNodeHtml, registerRendererAssetName } from "./renderer.js";
import { teardownNode } from "./node-teardown.js";
import { normalizeClipboardImage } from "./clipboard-image.js";
import { appendOriginAttachmentThumbnails, originAttachmentNames } from "./origin-attachments.js";
import { createEdgeScroller } from "./edge-scroll.js";
import { createAnchoredMenu } from "./primitives/anchored-menu.js";

function isSelectionBranch(node) {
  return branchTypeOfNode(node) === BRANCH_SELECTION;
}

function isFollowup(node) {
  return branchTypeOfNode(node) === BRANCH_FOLLOWUP;
}

function clipboardImageFiles(event) {
  var files = [];
  for (const item of Array.from(event.clipboardData?.items || [])) {
    if (item.kind !== "file" || !String(item.type || "").toLowerCase().startsWith("image/")) continue;
    var file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function flashClipboardImageError(error) {
  flashHint(error?.code === "asset_too_large" ? "That image is over 20 MB."
    : error?.code === "clipboard_image_too_large" ? "That image is too large."
    : "Couldn't paste that image.");
}

function defaultCanvasHooks(){
  return {
    hideAsk: function(){},
    sendFollowup: function(){ return null; },
    sendNote: function(){ return null; },
    sendPlacedNote: function(){ return null; },
    rollbackBranch: function(){},
    copyNodeMarkdown: function(){},
    removeBranch: function(){},
    persistNode: function(){},
    persistNodesBulk: function(){},
    scheduleViewSave: function(){},
    // Docked notes render on the cards this module owns, so the canvas asks
    // for them by hook rather than reaching into their module.
    renderDockedNotes: function(){},
    positionDockedNotes: function(){},
    closeDockedNotePopover: function(){}
  };
}

var canvasLifecycle = createModuleLifecycle({ defaults: defaultCanvasHooks });
var CARD_COMPOSER_COPY = Object.freeze({
  frozen: "Read-only snapshot",
  closed: "Session ended — saved",
  pending: "Still being written…",
  away: "Asks are saved for the agent…",
  live: "Ask or note…"
});
var STANDALONE_COMPOSER_COPY = Object.freeze({
  frozen: "Read-only snapshot",
  closed: "Session ended",
  pending: "Ask or note…",
  away: "Ask or note…",
  live: "Ask or note…"
});
var filmCameraHandle = null;
var cardResizeObserver = null;
var activePointerGestures = new Set();
var suppressClickUntil = 0;
var cardMenuController = null;
var cardMenuNode = null;
var collapseMenuController = null;
var collapseMenuNode = null;

export function registerCanvasHooks(hooks) {
  canvasLifecycle.register(hooks);
}

export function initCanvasView(){
  cleanupCanvasView(false);
  var canvasScope = canvasLifecycle.beginInit();
  if (typeof ResizeObserver === "function") cardResizeObserver = new ResizeObserver(scheduleEdges);
  var cardMenu = document.getElementById("cardmenu");
  cardMenuController = createAnchoredMenu({ surface: cardMenu, placement: "bottom-end",
    onClose: function(){ cardMenuNode = null; } });
  canvasScope.addCleanup(function(){ cardMenuController?.dispose(); cardMenuController = null; cardMenuNode = null; });
  canvasScope.listen(cardMenu, "click", onCardMenuClick);
  var collapseMenu = document.getElementById("collapsemenu");
  collapseMenuController = createAnchoredMenu({ surface: collapseMenu, placement: "bottom-end",
    onClose: function(){ collapseMenuNode = null; } });
  canvasScope.addCleanup(function(){ collapseMenuController?.dispose(); collapseMenuController = null; collapseMenuNode = null; });
  canvasScope.listen(collapseMenu, "click", onCollapseMenuClick);
  registerCoreHooks({
    ensureCanvasBuilt: ensureCanvasBuilt,
    diveToNode: diveToNode,
    scheduleEdges: scheduleEdges
  });
  canvasScope.listen(world, "mouseover", onWorldMouseOver);
  canvasScope.listen(world, "mouseout", onWorldMouseOut);
  initViewportPan();
  canvasScope.listen(viewport, "wheel", onViewportWheel, { passive: false });
  canvasScope.listen(viewport, "dblclick", onViewportDblClick);
  canvasScope.listen(document.getElementById("t-tidy"), "click", function(e){ tidy(motionSourceFromEvent(e)); });
  canvasScope.listen(document.getElementById("t-zin"), "click", function(){ zoomAt(viewport.clientWidth/2, viewport.clientHeight/2, 1.15); });
  canvasScope.listen(document.getElementById("t-zout"), "click", function(){ zoomAt(viewport.clientWidth/2, viewport.clientHeight/2, 0.87); });
  canvasScope.listen(zoomLabel, "click", function(){ zoomTo(viewport.clientWidth/2, viewport.clientHeight/2, 1); });
  exposeFilmCameraHook();
  return disposeCanvasView;
}

export function disposeCanvasView(){
  cleanupCanvasView(true);
}

export function closeCardMenu(settings){
  if (cardMenuController) cardMenuController.close(settings);
  if (collapseMenuController) collapseMenuController.close(settings);
}

function cleanupCanvasView(resetHooks){
  canvasLifecycle.dispose(resetHooks);
  if (cardResizeObserver) cardResizeObserver.disconnect();
  cardResizeObserver = null;
  activePointerGestures.forEach(function(cancel){ cancel(); });
  activePointerGestures.clear();
  suppressClickUntil = 0;
  cardMenuController = null;
  cardMenuNode = null;
  collapseMenuController = null;
  collapseMenuNode = null;
  cancelViewAnimation();
  if (edgeRaf){ cancelAnimationFrame(edgeRaf); edgeRaf = 0; }
  if (filmCameraHandle && window.__rhFilmCamera === filmCameraHandle) {
    try { delete window.__rhFilmCamera; } catch(_e){}
  }
  filmCameraHandle = null;
  if (edgesSvg) while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
  edgeEls = {};
  edgeGeometry = {};
  edgeHl = {};
  wheelKind = null;
  wheelCard = null;
  wheelTs = 0;
  viewport?.classList.remove("panning");
  if (resetHooks) {
    registerCoreHooks({
      ensureCanvasBuilt: function(){},
      diveToNode: function(){},
      scheduleEdges: function(){}
    });
  }
}

  // ===========================================================================
  // CANVAS
  // ===========================================================================
function applyTransform(){
    // The card menu is a fixed-position surface anchored to a card's screen
    // rect, and a transform moves that rect without resizing anything the
    // anchor observes. Panning or zooming with the menu open would strand it
    // mid-canvas, so the view moving dismisses it.
    if (cardMenuController && cardMenuController.isOpen()) cardMenuController.close({ restoreFocus: false });
    if (collapseMenuController && collapseMenuController.isOpen()) collapseMenuController.close({ restoreFocus: false });
    canvasLifecycle.hooks.closeDockedNotePopover({ restoreFocus: false, commit: true });
    world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
    zoomLabel.textContent = Math.round(view.scale * 100) + "%";
    canvasLifecycle.hooks.scheduleViewSave();
  }
  function exposeFilmCameraHook(){
    var enabled = false;
    try { enabled = localStorage.getItem("rh-film") === "1"; } catch(e){}
    if (!enabled) return;
    filmCameraHandle = {
      getView: function(){
        return { x: view.x, y: view.y, scale: view.scale };
      },
      setView: function(x, y, scale){
        cancelViewAnimation();
        setViewAdjusted(true);
        view.x = Number(x);
        view.y = Number(y);
        view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale)));
        applyTransform();
        drawEdges();
        return { x: view.x, y: view.y, scale: view.scale };
      }
    };
    Object.defineProperty(window, "__rhFilmCamera", {
      configurable: true,
      value: filmCameraHandle
    });
  }
function screenToWorld(sx, sy){ return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale }; }
  // The canvas the human can actually see: the viewport minus the chrome that
  // floats over it. Framing, note placement, and edge-scroll all owe the same
  // answer, or they aim at pixels hidden under the rail or the taskbar.
  function visibleCanvasRect(){
    var fullW = viewport.clientWidth || window.innerWidth;
    var fullH = viewport.clientHeight || window.innerHeight;
    var rail = document.getElementById("web-rail"), taskbar = document.getElementById("taskbar");
    var left = (rail && rail.classList.contains("open")) ? rail.getBoundingClientRect().width : 0;
    var top = taskbar ? taskbar.getBoundingClientRect().height : 0;
    return { left: left, top: top, right: fullW, bottom: fullH, width: fullW - left, height: fullH - top };
  }
  function zoomAt(sx, sy, factor){
    var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    zoomTo(sx, sy, next);
  }
  function zoomTo(sx, sy, next){
    cancelViewAnimation(); // manual zoom cancels any in-flight glide
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (next === view.scale) return;
    setViewAdjusted(true);
    var w = screenToWorld(sx, sy); view.scale = next; view.x = sx - w.x * view.scale; view.y = sy - w.y * view.scale; applyTransform();
  }
  var NODE_EXPAND_ICON = iconSvg("expand");
  var NODE_COLLAPSE_ICON = iconSvg("collapse");
  var NODE_MORE_ICON = iconSvg("more");
  var NODE_RESTORE_ICON = iconSvg("restore");

  function syncCollapseButton(node, btn){
    // "card", not "document": expanding a *document* is the reader button's
    // name, and the two actions must never share an accessible name.
    var action = node.collapsed ? "Expand card" : "Collapse card";
    btn.innerHTML = node.collapsed ? NODE_RESTORE_ICON : NODE_COLLAPSE_ICON;
    btn.setAttribute("aria-label", action); btn.title = action;
  }

  function nodeMenuButton(node){
    var button = cardButton(iconButtonMarkup({ bare: true, className: "node-btn node-more", svgIconHtml: NODE_MORE_ICON,
      ariaLabel: "Card menu", title: "Card menu", ariaHaspopup: "menu", ariaControls: "cardmenu", ariaExpanded: "false" }));
    button.addEventListener("click", function(e){ e.stopPropagation(); openCardMenu(node, button, e.detail === 0); });
    node.moreBtn = button;
    return button;
  }
  function ensureNodeMenuButton(node){
    if (!node || node._ephemeral || node.moreBtn || !node.actsEl) return;
    node.actsEl.appendChild(nodeMenuButton(node));
  }
export function canConvertNote(node){
    return !!node && !node._ephemeral && !frozen && !closed && node.id !== rootId && isNoteNode(node) && childrenOf(node.id).length === 0;
  }
  function openCardMenu(node, trigger, openedByKeyboard){
    if (!cardMenuController || node._ephemeral) return;
    // The menu is anchored to the card's screen rect, and applyTransform
    // dismisses it whenever the view moves — so a reveal glide still in flight
    // would close the menu on its very next frame. Reaching for a card's ⋯ is
    // a gesture like zoom, drag, or pan: the glide yields to it.
    cancelViewAnimation();
    cardMenuNode = node;
    document.getElementById("cm-textreset").textContent = Math.round((node.font_scale || 1) * 100) + "%";
    // Collapsing is a way of looking, not a change to the hole, so the fold
    // group survives into a frozen snapshot exactly as the header's own
    // collapse button does.
    syncCollapseGroup(node, "cm-");
    document.getElementById("cm-rename").style.display = frozen ? "none" : "";
    document.getElementById("cm-convert").style.display = canConvertNote(node) && !!(node.md || "").trim() ? "" : "none";
    var showDelete = !frozen && node.id !== rootId;
    document.getElementById("cm-delete").style.display = showDelete ? "" : "none";
    document.querySelector("#cardmenu .cm-delete-sep").style.display = showDelete ? "" : "none";
    cardMenuController.toggle(trigger, { focusFirst: openedByKeyboard });
  }
  function onCardMenuClick(e){
    var button = e.target.closest && e.target.closest("button");
    var node = cardMenuNode;
    if (!button || !node) return;
    if (button.id === "cm-textdown" || button.id === "cm-textup" || button.id === "cm-textreset"){
      var scale = button.id === "cm-textreset" ? resetNodeFontScale(node)
        : changeNodeFontScale(node, button.id === "cm-textup" ? 0.1 : -0.1);
      document.getElementById("cm-textreset").textContent = Math.round(scale * 100) + "%";
      return;
    }
    cardMenuController.close();
    if (button.id === "cm-copy") canvasLifecycle.hooks.copyNodeMarkdown(node);
    else if (button.id === "cm-rename") startTitleEditing(node, node.titleEl);
    else if (button.id === "cm-convert") convertNoteToAsk(node, node.md);
    else if (button.id.indexOf("cm-collapse") === 0) runCollapseAction(node, button.id.slice(3));
    else if (button.id === "cm-delete") canvasLifecycle.hooks.removeBranch(node);
  }

  // The subtree's own fold state, read off the direct children only: once every
  // one of them is folded the children row flips to "expand", and nothing deeper
  // gets a vote (a half-open grandchild must not keep the label saying
  // "collapse" when the row under the card is already shut).
  function childrenAllCollapsed(node){
    var kids = placedChildren(node.id);
    return kids.length > 0 && kids.every(function(kid){ return !!kid.collapsed; });
  }
  // Docked notes are drawn on their parent, not beside it: they have no card to
  // fold, no place to tidy into, and no bounds to frame.
  function placedChildren(id){
    return childrenOf(id).filter(function(kid){ return !isDockedNote(kid); });
  }
  // Three scopes, three rows, each flipping on exactly the thing its own noun
  // names: the card, the card plus its subtree, the subtree alone. A card with
  // nothing under it keeps only the row about itself.
  function syncCollapseGroup(node, prefix){
    var hasChildren = placedChildren(node.id).length > 0;
    syncCollapseRow(document.getElementById(prefix + "collapse"), !!node.collapsed, "", true);
    syncCollapseRow(document.getElementById(prefix + "collapse-branch"), !!node.collapsed, " branch", hasChildren);
    syncCollapseRow(document.getElementById(prefix + "collapse-children"), childrenAllCollapsed(node), " children", hasChildren);
  }
  // Only the verb flips. The row's glyph names its scope, which the card's state
  // never changes, so the shell's per-row mini-tree has to survive every open.
  function syncCollapseRow(item, expands, noun, shown){
    item.style.display = shown ? "" : "none";
    item.querySelector(".sm-label").textContent = (expands ? "Expand" : "Collapse") + noun;
  }
  // Each row does what its label just said, so the action reads the same state
  // the label was rendered from.
  function runCollapseAction(node, action){
    if (action === "collapse") toggleCollapse(node, false);
    else if (action === "collapse-branch") setBranchCollapsed(node, !node.collapsed);
    else if (action === "collapse-children") setChildrenCollapsed(node, !childrenAllCollapsed(node));
  }
  // Left-click on the header's collapse button folds this card; right-click
  // offers all three scopes. The gesture always answers — a childless card just
  // gets the one row that means anything to it.
  function openCollapseMenu(node, trigger){
    if (!collapseMenuController || node._ephemeral) return false;
    // Same anchoring race as the card menu: applyTransform dismisses anything
    // pinned to a card's screen rect, so an in-flight glide would close this
    // menu on its very next frame. Reaching for the button yields the glide.
    cancelViewAnimation();
    collapseMenuNode = node;
    syncCollapseGroup(node, "cc-");
    collapseMenuController.toggle(trigger, { focusFirst: false });
    return true;
  }
  function onCollapseMenuClick(e){
    var button = e.target.closest && e.target.closest("button");
    var node = collapseMenuNode;
    if (!button || !node) return;
    collapseMenuController.close();
    runCollapseAction(node, button.id.slice(3));
  }

export function createNodeEl(node, enter){
    var el = document.createElement("div");
    el.className = "node" + (node.id === rootId ? " root" : "") + (isNoteNode(node) ? " node-note" : "");
    if (node.id === currentNodeId) el.className += " current";
    if (enter && !document.hidden && !shouldReduceMotion()) el.className += " node-enter";
    el.dataset.id = node.id;

    var head = document.createElement("div");
    head.className = "node-head";
    if (node.id === rootId){
      var badge = document.createElement("span"); badge.className = "node-badge"; badge.innerHTML = BUNNY_MARK_SVG;
      badge.title = "Where this Rabbithole begins";
      head.appendChild(badge);
    }
    var titleEl = document.createElement("span"); titleEl.className = "node-title"; titleEl.textContent = node.title || "…";
    titleEl.title = node.title || "";
    // The collapse button owns a second, right-click-only surface for the
    // subtree, so it carries the popup wiring the anchored menu keeps in sync.
    var collapseBtn = cardButton(iconButtonMarkup({ bare: true, className: "node-btn node-collapse", svgIconHtml: NODE_COLLAPSE_ICON, ariaLabel: "Collapse card", title: "Collapse card",
      ariaHaspopup: "menu", ariaControls: "collapsemenu", ariaExpanded: "false" }));
    syncCollapseButton(node, collapseBtn);
    var openBtn = cardButton(iconButtonMarkup({ bare: true, className: "node-btn", svgIconHtml: NODE_EXPAND_ICON, ariaLabel: "Expand document", title: "Expand document" }));
    var divider = document.createElement("span"); divider.className = "node-act-divider"; divider.setAttribute("aria-hidden", "true");
    var acts = document.createElement("span"); acts.className = "node-acts";
    node.actsEl = acts; node.actDivider = divider;
    // Window controls first, then the divider, then the ⋮ menu at the outer
    // edge — the rightmost thing in the header, where every card menu lives.
    // Real DOM order, so tab order and reading order are the same order.
    acts.appendChild(collapseBtn); acts.appendChild(openBtn); acts.appendChild(divider);
    if (!node._ephemeral) acts.appendChild(nodeMenuButton(node));
    head.appendChild(titleEl); head.appendChild(acts);

    var body = document.createElement("div"); body.className = "node-body";
    var comp = buildCardComposer(node);
    var resize = document.createElement("div"); resize.className = "node-resize";
    el.appendChild(head); el.appendChild(body); el.appendChild(comp); el.appendChild(resize);
    world.appendChild(el);

    node.el = el; node.bodyEl = body; node.titleEl = titleEl; node.collapseBtn = collapseBtn;
    if (cardResizeObserver) cardResizeObserver.observe(el);
    fillBody(node);
    updateCardComposer(node);
    if (node.collapsed) el.classList.add("collapsed");

    enableDrag(node, head);
    enableResize(node, resize);
    head.addEventListener("dblclick", function(e){
      var hit = e.target.closest && e.target.closest(".node-title");
      if (!hit && e.target === head){
        var pointHit = document.elementFromPoint(e.clientX, e.clientY);
        hit = pointHit && pointHit.closest && pointHit.closest(".node-title");
      }
      if (hit === titleEl){
        var titleRange = document.createRange(); titleRange.selectNodeContents(titleEl);
        var textRect = titleRange.getBoundingClientRect();
        if (e.clientX >= textRect.left && e.clientX <= textRect.right && e.clientY >= textRect.top && e.clientY <= textRect.bottom){
          e.preventDefault(); e.stopPropagation(); startTitleEditing(node, titleEl); return;
        }
      }
      if (!onCardControl(e)) openNode(node.id);
    });
    openBtn.addEventListener("click", function(e){ e.stopPropagation(); openNode(node.id); });
    collapseBtn.addEventListener("click", function(e){ e.stopPropagation(); toggleCollapse(node, e.altKey); });
    collapseBtn.addEventListener("contextmenu", function(e){
      if (!openCollapseMenu(node, collapseBtn)) return;
      e.preventDefault(); e.stopPropagation();
    });
    // Scrolling a card moves the inline marks its children's edges start from.
    body.addEventListener("scroll", scheduleEdges, { passive: true });
    if (isNoteNode(node)) body.addEventListener("dblclick", function(e){
      var dc = e.target.closest && e.target.closest(".doc-content");
      if (!dc || !body.contains(dc)) return;
      if (e.target.closest("a, button, input, textarea, select, summary, [contenteditable], [role=button], [role=link], [data-child]")) return;
      e.stopPropagation();
      startNoteEditing(node, dc, markdownCaretForPrefix(node.md || "", renderedPrefixAtPoint(dc, e.clientX, e.clientY)));
    });
    // Hovering a card lights up its edge and the exact text it branched from.
    el.addEventListener("mouseenter", function(){ focusOrigin(node, true); });
    el.addEventListener("mouseleave", function(){
      focusOrigin(node, false);
      if (node.ncComp && !node.ncText.value.trim() && document.activeElement !== node.ncText) closeCardDrawer(node);
    });

    layoutNode(node);
    if (el.classList.contains("node-enter")){
      requestAnimationFrame(function(){
        el.classList.add("entered");
        setTimeout(function(){ el.classList.remove("node-enter"); el.classList.remove("entered"); }, 220);
      });
    }
    return node;
  }

  // The camera pose that frames a card at reading scale.
function diveTargetView(node){
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var ts = Math.min(1, Math.max(0.75, Math.min((vw - 120) / node.w, (vh - 120) / effH(node))));
    return { x: vw / 2 - (node.x + node.w / 2) * ts, y: vh / 2 - (node.y + effH(node) / 2) * ts, scale: ts };
  }
  // Glide the canvas view into a card at reading scale.
function diveToNode(node, source){
    var t = diveTargetView(node);
    animateView(t.x, t.y, t.scale, { source: source, duration: 270, ease: "inOut" });
  }
  // A card's on-screen rect under a given camera pose (defaults to the live one).
function cardScreenRect(node, v){
    v = v || view;
    return { left: node.x * v.scale + v.x, top: node.y * v.scale + v.y, width: node.w * v.scale, height: effH(node) * v.scale };
  }
function rectMostlyVisible(rect){
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var w = Math.min(rect.left + rect.width, vw) - Math.max(rect.left, 0);
    var h = Math.min(rect.top + rect.height, vh) - Math.max(rect.top, 0);
    if (w <= 0 || h <= 0) return false;
    return (w * h) / (rect.width * rect.height) >= 0.3;
  }
  function cardButton(markup){
    var template = document.createElement("template");
    template.innerHTML = markup;
    return template.content.firstElementChild;
  }

  // ---------- per-card follow-up composer ----------
  // The scrollbar only appears once the textarea is actually at its cap —
  // otherwise sub-pixel rounding paints a stray thumb next to the commit row.
export function autoGrowEl(ta, max){
    ta.style.height = "auto";
    ta.style.height = Math.min(max, ta.scrollHeight) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }
  function buildCardComposer(node){
    var comp = document.createElement("div"); comp.className = "node-composer";
    var clip = document.createElement("div"); clip.className = "nc-clip"; clip.id = cardDrawerId(node);
    var inner = document.createElement("div"); inner.className = "nc-inner followup-composer";
    var input = document.createElement("div"); input.className = "ask-input";
    var ta = document.createElement("textarea"); ta.rows = 1;
    var actions = cardButton(composerActionsMarkup());
    var handle = document.createElement("button"); handle.type = "button"; handle.className = "nc-handle"; handle.title = "Ask or note about this document";
    handle.setAttribute("aria-expanded", "false"); handle.setAttribute("aria-controls", clip.id);
    var plus = document.createElement("span"); plus.className = "nc-plus"; plus.textContent = "+";
    handle.appendChild(plus); handle.appendChild(document.createTextNode(" Ask or note"));
    input.appendChild(ta); inner.appendChild(input); inner.appendChild(actions); clip.appendChild(inner);
    comp.appendChild(clip); comp.appendChild(handle);
    node.ncComp = comp; node.ncInner = inner; node.ncText = ta; node.ncActions = actions; node.ncHandle = handle;
    handle.addEventListener("click", function(e){ e.stopPropagation(); openCardDrawer(node); });
    ta.addEventListener("input", function(){ autoGrowEl(ta, 90); updateCardComposer(node); });
    ta.addEventListener("keydown", function(e){
      if (e.key === "Escape"){ e.stopPropagation(); closeCardDrawer(node); handle.focus({ preventScroll: true }); }
    });
    wireComposerActions({ text: ta, actions: actions,
      onCommit: function(kind, e){ e.stopPropagation(); submitCardFollowup(node, kind, cardComposerSource(e)); },
      onLens: function(lens, e){ e.stopPropagation(); submitCardLens(node, lens, cardComposerSource(e)); } });
    // Click-away with an empty drawer tucks it back in (a draft keeps it out).
    ta.addEventListener("blur", function(){
      if (!ta.value.trim() && !(node.el && node.el.matches(":hover"))) closeCardDrawer(node);
    });
    return comp;
  }
  function cardComposerSource(e){ return e && e.type === "keydown" ? "keyboard" : motionSourceFromEvent(e); }
  function cardDrawerId(node){
    return "card-followup-" + String(node.id).replace(/[^A-Za-z0-9_-]/g, function(ch){ return "-" + ch.charCodeAt(0).toString(16) + "-"; });
  }
  // preventScroll matters: a plain focus() would yank the overflow-hidden
  // viewport around to reveal the textarea, fighting the canvas transform.
  function openCardDrawer(node){
    // This is a card-embedded disclosure, not a floating surface: its
    // hover/draft lifecycle owns dismissal, so it does not join the layer stack.
    node.ncComp.classList.add("open");
    node.ncHandle.setAttribute("aria-expanded", "true");
    node.ncText.focus({ preventScroll: true });
  }
  function closeCardDrawer(node){
    node.ncComp.classList.remove("open");
    node.ncHandle.setAttribute("aria-expanded", "false");
  }
  // Same honest states as the reader's composer: an away agent doesn't disable
  // asking (questions queue server-side); only a pending doc or a dead session does.
export function updateCardComposer(node){
    if (node._noteComposer){ updateStandaloneNoteComposer(node); return; }
    if (node._noteEditor && !canConvertNote(node)){
      var convert = node._noteEditSurface && node._noteEditSurface.querySelector('[data-commit="ask"]');
      if (convert){ convert.remove(); node._noteEditSurface.querySelector(".ask-actions")?.classList.add("note-only"); }
    }
    if (!node.ncText) return;
    // A draft in progress keeps the drawer out even when the pointer wanders off.
    var hasDraft = !!node.ncText.value.trim();
    node.ncComp.classList.toggle("nc-draft", hasDraft);
    node.ncInner.classList.toggle("has-draft", hasDraft);
    applyComposerState(
      { text: node.ncText, commits: node.ncActions.querySelectorAll(".ask-commit"),
        lenses: node.ncActions.querySelectorAll(".lens"), wrap: node.ncInner },
      { phase: sessionPhase(), pending: node.status === "pending" || !!node.extensions?.pdf?.converting },
      CARD_COMPOSER_COPY
    );
  }
  // The card composer's submit gate (a closed session says so out loud), and
  // the shared landing: retract the drawer and pan the new card into view.
  function cardComposerBlocked(node){
    if (closed){ flashHint("Session ended — reopen this Rabbithole from your terminal to continue."); return true; }
    return node.status === "pending" || !!node.extensions?.pdf?.converting;
  }
  function settleCardSubmit(node, kid, source){
    closeCardDrawer(node);
    updateCardComposer(node);
    revealNode(kid, source);
  }
  // A lens on a card is a whole-document ask on that card — canned question,
  // same contract as the reader composer and the empty-box popover lenses.
  function submitCardLens(node, lens, source){
    if (cardComposerBlocked(node)) return;
    var kid = canvasLifecycle.hooks.sendFollowup(node, LENSES[lens].q, lens);
    if (kid) settleCardSubmit(node, kid, source);
  }
  function submitCardFollowup(node, commit, source){
    if (cardComposerBlocked(node)) return;
    var question = node.ncText.value.trim();
    if (!question) return;
    var kid = commit === "note" ? canvasLifecycle.hooks.sendNote(node, question)
      : commit === "note-window" ? canvasLifecycle.hooks.sendPlacedNote(node, question)
      : canvasLifecycle.hooks.sendFollowup(node, question, null);
    if (!kid) return;
    node.ncText.value = "";
    autoGrowEl(node.ncText, 90);
    settleCardSubmit(node, kid, source);
  }
  // Asking from a card spawns the answer card wherever placeChild puts it —
  // possibly off-screen. Pan just enough to bring it into view (user-initiated,
  // so moving the viewport is expected; streaming never does this).
export function revealNode(n, source){
    if (mode !== "canvas" || !n || isNoteNode(n)) return;
    var pad = 30, vw = viewport.clientWidth, vh = viewport.clientHeight;
    var x1 = n.x * view.scale + view.x, y1 = n.y * view.scale + view.y;
    var x2 = (n.x + n.w) * view.scale + view.x, y2 = (n.y + effH(n)) * view.scale + view.y;
    var dx = 0, dy = 0;
    if (x2 > vw - pad) dx = vw - pad - x2;
    if (x1 + dx < pad) dx = pad - x1;
    if (y2 > vh - pad) dy = vh - pad - y2;
    if (y1 + dy < pad) dy = pad - y1;
    if (!dx && !dy) return;
    animatePan(view.x + dx, view.y + dy, source, 230, "out");
  }
function animatePan(tx, ty, source, duration, ease){ animateView(tx, ty, view.scale, { source: source, duration: duration, ease: ease }); }
  // One shared view glide (pan + zoom together): frame-all, reveal, and
  // search/activity jumps. A newer glide cancels an in-flight one; hidden windows jump
  // instantly (rAF never fires there).
  var viewAnimId = 0, viewAnimRaf = 0;
export function cancelViewAnimation(){
    viewAnimId++;
    if (viewAnimRaf){ cancelAnimationFrame(viewAnimRaf); viewAnimRaf = 0; }
  }
function animateView(tx, ty, ts, opts){
    opts = opts || {};
    cancelViewAnimation();
    var myId = viewAnimId;
    if (document.hidden || shouldReduceMotion() || opts.source !== "pointer"){
      view.x = tx; view.y = ty; view.scale = ts; applyTransform(); return;
    }
    var sx = view.x, sy = view.y, ss = view.scale, t0 = performance.now(), D = opts.duration || 270;
    var easeFn = opts.ease === "inOut" ? easeInOutMotion : easeOutMotion;
    function step(t){
      viewAnimRaf = 0;
      if (myId !== viewAnimId) return;
      var p = Math.min(1, (t - t0) / D), k = easeFn(p);
      view.x = sx + (tx - sx) * k; view.y = sy + (ty - sy) * k; view.scale = ss + (ts - ss) * k; applyTransform();
      if (p < 1) viewAnimRaf = requestAnimationFrame(step);
    }
    viewAnimRaf = requestAnimationFrame(step);
  }

export function fillBody(node){
    var body = node.bodyEl; if (!body) return;
    if (node._noteEditor) return;
    var previous = body.querySelector(".doc-content"); if (previous && previous._rhDispose) previous._rhDispose();
    body.classList.remove("pdf-body");
    body.innerHTML = "";
    if (node.origin && node.origin.selected_text){
      var q = document.createElement("div"); q.className = "origin-quote"; q.textContent = "“" + node.origin.selected_text + "”";
      appendOriginAttachmentThumbnails(q, node);
      body.appendChild(q);
    } else if (node.origin && (node.origin.question || node.origin.lens || originAttachmentNames(node).length)){
      var fq = document.createElement("div"); fq.className = "origin-quote";
      fq.textContent = node.origin.lens ? "Follow-up — " + lensLabel(node.origin.lens) : (node.origin.question || "Pasted image");
      appendOriginAttachmentThumbnails(fq, node);
      body.appendChild(fq);
    }
    var crop = buildOriginCrop(node, "card");
    if (crop) body.appendChild(crop);
    var dc = buildDocContent(node, CANVAS_BASE);
    body.appendChild(dc);
    body.classList.toggle("pdf-body", dc.classList.contains("rh-pdf"));
    applyChildHighlights(dc, node);
    // The marks exist now, so the margin column that points at them can be built.
    canvasLifecycle.hooks.renderDockedNotes(node);
  }
  function noteSurface(node, surface){
    var dc = buildDocContent(node, surface === "reader" ? READER_BASE : CANVAS_BASE);
    applyChildHighlights(dc, node);
    return dc;
  }
  function replaceNoteSurface(node, surface, current){
    var dc = noteSurface(node, surface);
    current.replaceWith(dc);
    return dc;
  }
  function cssPixels(style, property){
    return parseFloat(style[property]) || 0;
  }
  // One bar for every note surface — the composer's own Note/Ask pair, built
  // and keyed the same way whether the note is being written for the first time
  // or edited afterwards. Note commits the text, Ask branches it, ⌘↵ asks.
export function noteComposerActions(){
    return cardButton(composerActionsMarkup({ includeLenses: false, noteEnterShortcut: false }));
  }
export function noteCommitFromEnter(e){
    if (e.altKey || !(e.metaKey || e.ctrlKey) || !isCommandEnter(e)) return null;
    return e.shiftKey ? "note-window" : "ask";
  }
  // Whatever the editor sits under inside the card body — an origin quote, an
  // origin crop — belongs to the body, not to the surface, so its height comes
  // off the ceiling before the textarea takes its share.
  function leadingBodyHeight(surface){
    var total = 0;
    for (var el = surface.previousElementSibling; el; el = el.previousElementSibling){
      var style = getComputedStyle(el);
      total += el.offsetHeight + cssPixels(style, "marginTop") + cssPixels(style, "marginBottom");
    }
    return total;
  }
  // The textarea and card share one ceiling. Derive the text allowance from
  // the card's saved cap and the live composer chrome so neither can stop
  // growing while the other still has unused room. Both flush-footer note
  // surfaces — the fresh composer and the editor over an existing note — are
  // the same box, so they measure themselves the same way.
  function noteEditorCap(node, input, actions, attachmentStrip){
    var cardStyle = getComputedStyle(node.el);
    var inputStyle = getComputedStyle(input);
    var surfaceStyle = getComputedStyle(input.parentNode);
    return Math.max(1,
      node.h - node.el.querySelector(".node-head").offsetHeight - actions.offsetHeight -
      (attachmentStrip ? attachmentStrip.offsetHeight : 0) - leadingBodyHeight(input.parentNode) -
      cssPixels(cardStyle, "borderTopWidth") - cssPixels(cardStyle, "borderBottomWidth") -
      cssPixels(inputStyle, "paddingTop") - cssPixels(inputStyle, "paddingBottom") -
      cssPixels(surfaceStyle, "borderTopWidth") - cssPixels(surfaceStyle, "borderBottomWidth") -
      cssPixels(surfaceStyle, "paddingTop") - cssPixels(surfaceStyle, "paddingBottom"));
  }
  function growStandaloneNoteComposer(node){
    if (!node._noteEditor || !node._noteComposer) return;
    autoGrowEl(node._noteEditor, noteEditorCap(node, node._noteInput, node._noteActions, node._noteAttachmentStrip));
  }
  function updateStandaloneNoteComposer(node){
    if (!node._noteEditor || !node._noteComposer) return;
    var parent = nodes[rootId];
    var hasDraft = !!node._noteEditor.value.trim() || !!node._noteAttachments?.length || !!node._notePastePending;
    node._noteComposer.classList.toggle("has-draft", hasDraft);
    var rootPending = !parent || parent.status === "pending" || !!parent.extensions?.pdf?.converting;
    applyComposerState(
      { text: node._noteEditor, commits: node._noteActions.querySelectorAll(".ask-commit"),
        wrap: node._noteComposer, hasDraft: hasDraft },
      { phase: sessionPhase(), pending: false,
        disabled: !!node._noteUploading || !!node._noteNormalizing },
      STANDALONE_COMPOSER_COPY
    );
    var askCommit = node._noteActions.querySelector('[data-commit="ask"]');
    if (askCommit) askCommit.disabled = askCommit.disabled || rootPending;
  }
  function startStandaloneNoteComposer(node, dc){
    var scope = createCleanupScope();
    var composer = document.createElement("div"); composer.className = "nc-inner followup-composer";
    var input = document.createElement("div"); input.className = "ask-input";
    var editor = document.createElement("textarea");
    editor.className = "note-editor md";
    editor.rows = 1;
    editor.dataset.nodeId = node.id;
    editor.dataset.surface = dc.dataset.surface || "canvas";
    editor.setAttribute("aria-label", "Ask or write a note");
    editor.spellcheck = true;
    editor.value = node.md || "";
    editor.style.fontSize = dc.style.fontSize;
    var attachmentStrip = document.createElement("div"); attachmentStrip.className = "paste-attachment-strip"; attachmentStrip.hidden = true;
    var actions = noteComposerActions();
    input.appendChild(editor); composer.appendChild(input); composer.appendChild(attachmentStrip); composer.appendChild(actions); dc.replaceWith(composer);
    node._noteEditor = editor; node._noteComposer = composer; node._noteActions = actions; node._noteInput = input;
    node._noteAttachmentStrip = attachmentStrip;
    var attachments = []; node._noteAttachments = attachments;
    var uploadedNames = new Set(); node._noteUploadedAssets = uploadedNames;
    var pendingAssetCleanup = Promise.resolve();
    var pendingPasteCount = 0;
    var pasteQueue = Promise.resolve();
    function releaseAttachment(attachment){
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    function releaseAttachments(){
      attachments.splice(0).forEach(releaseAttachment);
    }
    scope.addCleanup(releaseAttachments);
    node._noteDraftDispose = scope.dispose;
    node._noteDockedComposer = node.ncComp;
    if (node._noteDockedComposer?.parentNode) node._noteDockedComposer.parentNode.removeChild(node._noteDockedComposer);
    node.el.classList.add("note-draft");
    var settled = false;
    function queueAssetCleanup(names, keepTracked){
      names = Array.from(new Set(names || []));
      if (!names.length) return;
      if (!keepTracked) names.forEach(function(name){ uploadedNames.delete(name); });
      var cleanup = Promise.all(names.map(function(name){
        return Promise.resolve(deleteAsset(name)).catch(function(){});
      }));
      pendingAssetCleanup = Promise.allSettled([pendingAssetCleanup, cleanup]).then(function(){});
    }
    scope.addCleanup(function(){
      settled = true;
      queueAssetCleanup(Array.from(uploadedNames), true);
    });
    function release(restoreDockedComposer){
      node._noteDraftDispose = null;
      scope.dispose();
      node._noteEditor = null; node._noteComposer = null; node._noteActions = null; node._noteInput = null;
      node._noteAttachmentStrip = null; node._noteAttachments = null; node._noteUploadedAssets = null;
      node._noteUploading = false; node._noteNormalizing = false; node._notePastePending = 0;
      if (restoreDockedComposer && node.el && node._noteDockedComposer){
        node.el.insertBefore(node._noteDockedComposer, node.el.querySelector(".node-resize"));
      }
      node._noteDockedComposer = null;
      if (node.el) node.el.classList.remove("note-draft");
    }
    function discard(){
      if (settled || node._noteUploading) return;
      settled = true;
      release(false);
      teardownNode(node.id);
    }
    async function submit(kind, event){
      if (settled || node._noteUploading || node._noteNormalizing) return;
      var parent = nodes[rootId];
      if (closed || frozen) return;
      if (kind === "ask" && (!parent || parent.status === "pending" || !!parent.extensions?.pdf?.converting)) return;
      var text = editor.value.trim();
      if (!text && !attachments.length) return;
      node._noteUploading = true;
      updateStandaloneNoteComposer(node);
      await pendingAssetCleanup;
      if (settled || !node.el) return;
      uploadedNames.clear();
      try {
        for (const attachment of attachments) {
          const response = await putAsset(attachment.name, attachment.blob);
          if (settled || !node.el) {
            if (response && response.ok) Promise.resolve(deleteAsset(attachment.name)).catch(function(){});
            return;
          }
          if (!response || !response.ok) throw new Error("Asset upload failed");
          uploadedNames.add(attachment.name);
        }
      } catch (_error) {
        if (settled || !node.el) return;
        queueAssetCleanup(Array.from(uploadedNames), false);
        node._noteUploading = false;
        updateStandaloneNoteComposer(node);
        flashHint("Couldn't save those images — try again.");
        editor.focus({ preventScroll: true });
        return;
      }
      if (settled || !node.el) return;
      var attachmentNames = attachments.map(function(attachment){ return attachment.name; });
      var committedHeight = Math.min(node.h, Math.max(DEFAULT_STANDALONE_NOTE.h, node.el.offsetHeight));
      if (kind === "ask"){
        var requestId = uuid();
        var askResponse = await Promise.resolve(postBrowserEvent({ type: "branch_request", request_id: requestId,
          node_id: node.id, parent_id: null, selected_text: "", question: text,
          lens: null, anchor: null, branch_type: BRANCH_FOLLOWUP,
          ...(attachmentNames.length ? { attachment_assets: attachmentNames } : {}),
          position: { x: node.x, y: node.y }, size: { w: node.w, h: committedHeight } })).catch(function(){ return null; });
        if (settled || !node.el) return;
        if (!askResponse || !askResponse.ok){
          queueAssetCleanup(Array.from(uploadedNames), true);
          node._noteUploading = false;
          updateStandaloneNoteComposer(node);
          flashHint("Couldn't reach the agent — that ask wasn't posted.");
          editor.focus({ preventScroll: true });
          return;
        }
        uploadedNames.clear();
        node.h = committedHeight;
        settled = true;
        release(true);
        node.title = truncate(text, 48) || "Pasted image";
        node.md = "";
        node.html = "";
        node.base_url = parent.base_url || null;
        node.base_url_source = parent.base_url ? "inherited" : null;
        node.read = false;
        node.origin = { selected_text: "", question: text, lens: null, anchor: null, branch_type: BRANCH_FOLLOWUP,
          ...(attachmentNames.length ? { attachment_assets: attachmentNames } : {}) };
        node.status = "pending";
        node._startTs = Date.now();
        delete node._ephemeral;
        ensureNodeMenuButton(node);
        node.el.classList.remove("node-note");
        node.titleEl.textContent = node.title;
        node.titleEl.title = node.title;
        refreshNodeHtml(node);
        fillBody(node);
        layoutNode(node);
        updateCardComposer(node);
        scheduleEdges();
        // Removing the focused textarea can make an overflow-hidden ancestor
        // scroll to the replacement content. The canvas transform is the only
        // camera, so keep the DOM scroll pinned through the next layout frame.
        pinCanvasScroll();
        if (canvasLifecycle.scope) canvasLifecycle.scope.raf(pinCanvasScroll);
        return;
      }
      var imageMarkdown = attachmentNames.map(function(name){ return "![Pasted image](asset:" + name + ")"; });
      var noteMarkdown = [editor.value.trimEnd()].concat(imageMarkdown).filter(Boolean).join("\n\n");
      var noteResponse = await Promise.resolve(postBrowserEvent({ type: "node_create", id: node.id, parent_id: null,
        title: node.title, markdown: noteMarkdown, origin: node.origin,
        position: { x: node.x, y: node.y }, size: { w: node.w, h: committedHeight } })).catch(function(){ return null; });
      if (settled || !node.el) return;
      if (!noteResponse || !noteResponse.ok){
        queueAssetCleanup(Array.from(uploadedNames), true);
        node._noteUploading = false;
        updateStandaloneNoteComposer(node);
        flashHint("Couldn't save that note — try again.");
        editor.focus({ preventScroll: true });
        return;
      }
      uploadedNames.clear();
      settled = true;
      release(true);
      node.md = noteMarkdown;
      node.h = committedHeight;
      delete node._ephemeral;
      ensureNodeMenuButton(node);
      refreshNodeHtml(node);
      fillBody(node);
      layoutNode(node);
      updateCardComposer(node);
      scheduleEdges();
    }
    function pinCanvasScroll(){ viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    function renderAttachments(){
      var keepEditorFocus = document.activeElement === editor;
      attachmentStrip.replaceChildren();
      attachmentStrip.hidden = attachments.length === 0;
      attachments.forEach(function(attachment, index){
        var item = document.createElement("div"); item.className = "paste-attachment";
        var image = document.createElement("img"); image.src = attachment.previewUrl; image.alt = "Pasted image"; image.draggable = false;
        var remove = document.createElement("button"); remove.type = "button"; remove.className = "paste-attachment-remove";
        remove.dataset.attachmentIndex = String(index); remove.setAttribute("aria-label", "Remove pasted image"); remove.title = "Remove image"; remove.textContent = "×";
        item.append(image, remove); attachmentStrip.appendChild(item);
      });
      growStandaloneNoteComposer(node);
      updateStandaloneNoteComposer(node);
      if (keepEditorFocus && editor.isConnected) editor.focus({ preventScroll: true });
    }
    scope.listen(attachmentStrip, "click", function(e){
      var button = e.target.closest ? e.target.closest(".paste-attachment-remove") : null;
      if (!button) return;
      e.preventDefault(); e.stopPropagation();
      var index = Number(button.dataset.attachmentIndex);
      var removed = attachments.splice(index, 1)[0];
      if (removed){
        releaseAttachment(removed);
        if (uploadedNames.has(removed.name)) queueAssetCleanup([removed.name], false);
      }
      renderAttachments();
      editor.focus({ preventScroll: true });
    });
    scope.listen(editor, "paste", function(e){
      var imageFiles = clipboardImageFiles(e);
      if (!imageFiles.length) return;
      var available = Math.max(0, 4 - attachments.length - pendingPasteCount);
      var consumed = imageFiles.slice(0, available);
      if (imageFiles.length > consumed.length) flashHint("Up to 4 images per ask or note.");
      if (!consumed.length) return;
      e.preventDefault();
      pendingPasteCount += consumed.length;
      node._notePastePending = pendingPasteCount;
      node._noteNormalizing = true;
      updateStandaloneNoteComposer(node);
      pasteQueue = pasteQueue.then(async function(){
        for (const file of consumed) {
          try {
            const normalized = await normalizeClipboardImage(file);
            if (settled || !node.el) continue;
            attachments.push({ ...normalized, previewUrl: URL.createObjectURL(normalized.blob) });
          } catch (error) {
            flashClipboardImageError(error);
          } finally {
            pendingPasteCount -= 1;
            node._notePastePending = pendingPasteCount;
          }
        }
        node._noteNormalizing = pendingPasteCount > 0;
        if (!settled && node.el) renderAttachments();
      });
    });
    scope.listen(editor, "input", function(){
      growStandaloneNoteComposer(node);
      updateStandaloneNoteComposer(node);
      // A textarea caret can programmatically scroll an overflow-hidden
      // ancestor as it moves down. The camera transform, never DOM scroll,
      // owns the canvas position.
      pinCanvasScroll();
      scope.raf(pinCanvasScroll);
    });
    scope.listen(editor, "keydown", function(e){
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation(); discard();
    });
    wireComposerActions({ text: editor, actions: actions, listen: scope.listen,
      hasDraft: function(){ return !!editor.value.trim() || attachments.length > 0; },
      commitFromEnter: noteCommitFromEnter,
      onCommit: function(kind, e){ e.stopPropagation(); submit(kind === "note-window" ? "note" : kind, e); },
      onLens: function(){} });
    // Moving between the textarea and its actions stays inside one surface.
    // Once focus truly leaves, an empty draft vanishes and a written draft
    // keeps the established note-editor blur behavior by saving as Note.
    scope.listen(composer, "focusout", function(){
      function settleBlur(){
        if (settled || composer.contains(document.activeElement)) return;
        if (node._noteNormalizing){ scope.timeout(settleBlur, 25); return; }
        if (editor.value.trim() || attachments.length) submit("note", null);
        else discard();
      }
      scope.timeout(settleBlur, 0);
    });
    growStandaloneNoteComposer(node);
    updateStandaloneNoteComposer(node);
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    pinCanvasScroll();
  }
  function refreshMountedNoteSurfaces(node, editor){
    var mounted = document.querySelectorAll('.doc-content[data-node-id="' + node.id + '"]');
    replaceNoteSurface(node, editor.dataset.surface, node._noteEditSurface || editor);
    mounted.forEach(function(dc){
      if (dc._rhDispose) dc._rhDispose();
      replaceNoteSurface(node, dc.dataset.surface, dc);
    });
    scheduleEdges();
  }
  // Leaving the editor — saved, cancelled, or converted — hands the card's
  // bottom edge back to its ordinary body padding and resize corner, and its
  // resting height back to layout.
  function endNoteEditingChrome(node){
    if (!node || !node.el) return;
    node.el.classList.remove("note-editing");
    layoutNode(node);
  }
  function cancelNoteEditing(node, editor){
    var surface = node._noteEditSurface || editor;
    endNoteEditingChrome(node);
    node._noteEditor = null;
    node._noteEditSurface = null;
    if (node._ephemeral){ teardownNode(node.id); return; }
    replaceNoteSurface(node, editor.dataset.surface, surface);
    scheduleEdges();
  }
export function startTitleEditing(node, titleEl){
    if (frozen || closed || titleEl.isContentEditable) return;
    var previous = node.title || "";
    titleEl.textContent = previous;
    titleEl.removeAttribute("title");
    titleEl.setAttribute("contenteditable", "plaintext-only");
    titleEl.focus({ preventScroll: true });
    var range = document.createRange(); range.selectNodeContents(titleEl);
    var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    var settled = false;
    function finish(save){
      if (settled) return;
      settled = true;
      var next = titleEl.textContent.trim();
      titleEl.removeEventListener("keydown", onKeyDown);
      titleEl.removeAttribute("contenteditable");
      if (save && next){ node.title = next; canvasLifecycle.hooks.persistNode(node); }
      titleEl.textContent = node.title || "…";
      titleEl.title = node.title || "";
      if (document.activeElement === titleEl) titleEl.blur();
    }
    function onKeyDown(e){
      if (e.key === "Escape"){
        e.preventDefault(); e.stopPropagation(); finish(false);
      } else if (e.key === "Enter"){
        e.preventDefault(); e.stopPropagation(); finish(true);
      }
    }
    titleEl.addEventListener("keydown", onKeyDown);
    titleEl.addEventListener("blur", function(){ finish(true); }, { once: true });
  }
  function commitNoteEditing(node, editor){
    var markdown = editor.value;
    if (!markdown.trim()){ cancelNoteEditing(node, editor); return; }
    endNoteEditingChrome(node);
    node._noteEditor = null;
    node.md = markdown;
    refreshNodeHtml(node);
    refreshMountedNoteSurfaces(node, editor);
    node._noteEditSurface = null;
    if (!node._ephemeral){ canvasLifecycle.hooks.persistNode(node); return; }
    delete node._ephemeral;
    ensureNodeMenuButton(node);
    Promise.resolve(postBrowserEvent({ type: "node_create", id: node.id, parent_id: null,
      title: node.title, markdown: node.md, origin: node.origin,
      position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } }))
      .then(function(response){
        if (response && response.ok) return;
        if (nodes[node.id] === node) teardownNode(node.id);
        flashHint("Couldn't save that note — it was undone.");
      });
  }
  function setConversionMarkState(node, pending){
    var parent = node.parent_id == null ? null : nodes[node.parent_id];
    var update = pending ? setPendingMarks : setNoteMarks;
    update(readerMain, node.id);
    if (parent && parent.bodyEl) update(parent.bodyEl, node.id);
  }
  function restoreConvertedNote(node, previous){
    node.title = previous.title;
    node.md = previous.md;
    node.base_url = previous.base_url;
    node.base_url_source = previous.base_url_source;
    node.read = previous.read;
    node.origin = previous.origin;
    node.status = previous.status;
    node._startTs = previous.startTs;
    if (previous.hadError) node.error = previous.error;
    else delete node.error;
    if (node.el) node.el.classList.add("node-note");
    if (node.titleEl){ node.titleEl.textContent = node.title; node.titleEl.title = node.title; }
    refreshNodeHtml(node);
    fillBody(node);
    layoutNode(node);
    updateCardComposer(node);
    setConversionMarkState(node, false);
    canvasLifecycle.hooks.persistNode(node);
    scheduleEdges();
  }
export function rollbackNoteConversion(node){
    var restore = node && node._noteConversionRollback;
    if (!restore) return;
    delete node._noteConversionRollback;
    canvasLifecycle.hooks.rollbackBranch(node, restore);
  }
export function convertNoteToAsk(node, text){
    var question = (text || "").trim();
    if (!question || !canConvertNote(node)) return false;
    var parentId = node.parent_id == null ? null : node.parent_id;
    var parent = nodes[parentId == null ? rootId : parentId];
    if (!parent) return false;
    var anchor = parentId == null ? null : (node.origin && node.origin.anchor || null);
    var attachmentNames = Array.from(extractNodeAssetRefs({ markdown: question })).slice(0, 4);
    var previous = {
      title: node.title, md: question, base_url: node.base_url, base_url_source: node.base_url_source,
      read: node.read, origin: node.origin, status: node.status, startTs: node._startTs,
      hadError: Object.prototype.hasOwnProperty.call(node, "error"), error: node.error
    };
    endNoteEditingChrome(node);
    node._noteEditor = null;
    node._noteEditSurface = null;
    node.title = truncate(question, 48);
    node.md = "";
    node.html = "";
    node.base_url = parent.base_url || null;
    node.base_url_source = parent.base_url ? "inherited" : null;
    node.read = false;
    node.origin = {
      selected_text: anchor ? String(previous.origin.selected_text || "").trim() : "",
      question: question,
      lens: null,
      anchor: anchor,
      branch_type: anchor ? BRANCH_SELECTION : BRANCH_FOLLOWUP,
      ...(attachmentNames.length ? { attachment_assets: attachmentNames } : {})
    };
    node.status = "pending";
    node._startTs = Date.now();
    delete node.error;
    if (node.el) node.el.classList.remove("node-note");
    if (node.titleEl){ node.titleEl.textContent = node.title; node.titleEl.title = node.title; }
    fillBody(node);
    layoutNode(node);
    updateCardComposer(node);
    setConversionMarkState(node, true);
    scheduleEdges();
    node._noteConversionRollback = function(){ restoreConvertedNote(node, previous); };
    var payload = { type: "branch_request", request_id: uuid(), node_id: node.id, parent_id: parentId,
      selected_text: node.origin.selected_text, question: question, lens: null, anchor: anchor,
      branch_type: node.origin.branch_type,
      position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h },
      ...(attachmentNames.length ? { attachment_assets: attachmentNames } : {}) };
    Promise.resolve(postBrowserEvent(payload)).then(function(response){
      if (!response || !response.ok) rollbackNoteConversion(node);
    }).catch(function(){ rollbackNoteConversion(node); });
    return true;
  }
  // The rendered text from the top of the note to the double-clicked point.
  // Null when the point doesn't resolve to text inside this note.
  function renderedPrefixAtPoint(dc, x, y){
    var caretNode = null, caretOffset = 0;
    if (document.caretPositionFromPoint){
      var pos = document.caretPositionFromPoint(x, y);
      if (pos){ caretNode = pos.offsetNode; caretOffset = pos.offset; }
    } else if (document.caretRangeFromPoint){
      var cr = document.caretRangeFromPoint(x, y);
      if (cr){ caretNode = cr.startContainer; caretOffset = cr.startOffset; }
    }
    if (!caretNode || !dc.contains(caretNode)) return null;
    var r = document.createRange();
    r.selectNodeContents(dc);
    try { r.setEnd(caretNode, caretOffset); } catch(e){ return null; }
    return r.toString();
  }
  function countOccurrences(haystack, needle){
    var count = 0, idx = haystack.indexOf(needle);
    while (idx !== -1){ count++; idx = haystack.indexOf(needle, idx + needle.length); }
    return count;
  }
  function nthOccurrence(haystack, needle, n){
    var idx = -1;
    while (n-- > 0){
      idx = haystack.indexOf(needle, idx === -1 ? 0 : idx + needle.length);
      if (idx === -1) return -1;
    }
    return idx;
  }
  // Maps a rendered-text prefix back to a caret offset in the markdown source.
  // Rendered text and markdown disagree on whitespace and syntax (**, #, links),
  // so match on a whitespace-stripped suffix of the prefix, longest needle
  // first; the needle's occurrence ordinal inside the prefix picks the right
  // duplicate. Returns -1 when nothing matches (caller falls back to the end).
  function markdownCaretForPrefix(md, prefix){
    if (prefix == null) return -1;
    var stripped = prefix.replace(/\s+/g, "");
    if (!stripped) return 0;
    var norm = "", map = [];
    for (var i = 0; i < md.length; i++){
      if (!/\s/.test(md[i])){ norm += md[i]; map.push(i); }
    }
    for (var len = Math.min(48, stripped.length); len >= 1; len -= (len > 12 ? 12 : 1)){
      var needle = stripped.slice(-len);
      var idx = nthOccurrence(norm, needle, countOccurrences(stripped, needle));
      if (idx !== -1) return map[idx + needle.length - 1] + 1;
    }
    return -1;
  }
  function startNoteEditing(node, dc, caretOffset){
    if (!isNoteNode(node) || frozen || closed || node._noteEditor) return;
    if (node._ephemeral){ startStandaloneNoteComposer(node, dc); return; }
    var surface = document.createElement("div");
    surface.className = "note-edit-surface has-draft";
    var input = document.createElement("div"); input.className = "ask-input";
    var editor = document.createElement("textarea");
    editor.className = "note-editor md";
    editor.rows = 1;
    editor.dataset.nodeId = node.id;
    editor.dataset.surface = dc.dataset.surface || "canvas";
    editor.setAttribute("aria-label", "Edit note");
    editor.spellcheck = true;
    editor.value = node.md || "";
    editor.style.fontSize = dc.style.fontSize;
    var actions = noteComposerActions();
    // A note that cannot become an ask (root, has children, frozen) keeps the
    // bar with Note alone — one button, so no divider down the middle.
    var convertible = canConvertNote(node);
    if (!convertible){ actions.querySelector('[data-commit="ask"]').remove(); actions.classList.add("note-only"); }
    input.appendChild(editor);
    surface.append(input, actions);
    dc.replaceWith(surface);
    // The card wears the edit state so its body can go full-bleed and its
    // resize corner can stand down while the footer owns the bottom edge.
    node.el.classList.add("note-editing");
    node._noteEditor = editor;
    node._noteEditSurface = surface;
    var settled = false;
    var settling = false;
    var uploadedNames = new Set();
    var pendingPasteCount = 0;
    var pasteQueue = Promise.resolve();
    // The bar is added to the card, not carved out of the text: for the length
    // of the edit the card's ceiling rises by the bar's own height, so every
    // line of the note stays exactly where it was. layoutNode hands the resting
    // height back on exit.
    function grow(){
      var grown = node.h + actions.offsetHeight;
      if (node.el.style.height === "auto") node.el.style.maxHeight = grown + "px";
      else node.el.style.height = grown + "px";
      autoGrowEl(editor, noteEditorCap(node, input, actions, null) + actions.offsetHeight);
    }
    function insertPastedImage(name){
      var start = editor.selectionStart;
      var end = editor.selectionEnd;
      var before = editor.value.slice(0, start);
      var after = editor.value.slice(end);
      var leading = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
      var trailing = after && !after.startsWith("\n\n") ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
      var insertion = leading + "![Pasted image](asset:" + name + ")" + trailing;
      editor.value = before + insertion + after;
      var nextCaret = before.length + insertion.length;
      editor.setSelectionRange(nextCaret, nextCaret);
      grow();
    }
    function updateActions(){
      var disabled = settling || !editor.value.trim();
      var commits = actions.querySelectorAll(".ask-commit");
      for (var i = 0; i < commits.length; i++) commits[i].disabled = disabled;
    }
    async function finish(kind){
      if (settled || settling) return;
      settling = true;
      updateActions();
      await pasteQueue;
      var referenced = kind === "cancel" ? new Set() : extractNodeAssetRefs({ markdown: editor.value });
      var cleanup = Array.from(uploadedNames).filter(function(name){ return !referenced.has(name); });
      await Promise.allSettled(cleanup.map(function(name){ return Promise.resolve(deleteAsset(name)); }));
      settled = true;
      if (kind === "ask" && convertNoteToAsk(node, editor.value)) return;
      if (kind === "note" || kind === "ask") commitNoteEditing(node, editor);
      else cancelNoteEditing(node, editor);
    }
    editor.addEventListener("input", function(){ grow(); updateActions(); });
    editor.addEventListener("paste", function(e){
      if (settled || settling) return;
      var imageFiles = clipboardImageFiles(e);
      if (!imageFiles.length) return;
      var available = Math.max(0, 4 - uploadedNames.size - pendingPasteCount);
      var consumed = imageFiles.slice(0, available);
      if (imageFiles.length > consumed.length) flashHint("Up to 4 images per ask or note.");
      if (!consumed.length) return;
      e.preventDefault();
      pendingPasteCount += consumed.length;
      pasteQueue = pasteQueue.then(async function(){
        for (const file of consumed) {
          try {
            var normalized;
            try {
              normalized = await normalizeClipboardImage(file);
            } catch (error) {
              flashClipboardImageError(error);
              continue;
            }
            var response = await putAsset(normalized.name, normalized.blob);
            if (!response || !response.ok){
              flashHint("Couldn't save that image — try again.");
              continue;
            }
            uploadedNames.add(normalized.name);
            registerRendererAssetName(normalized.name);
            insertPastedImage(normalized.name);
            updateActions();
          } catch (_error) {
            flashHint("Couldn't save that image — try again.");
          } finally {
            pendingPasteCount -= 1;
          }
        }
      });
    });
    editor.addEventListener("keydown", function(e){
      if (e.key === "Escape"){
        e.preventDefault(); e.stopPropagation(); finish("cancel");
      }
    });
    actions.addEventListener("pointerdown", function(e){
      if (e.target.closest && e.target.closest("button")) e.preventDefault();
    });
    wireComposerActions({ text: editor, actions: actions,
      hasDraft: function(){ return !!editor.value.trim(); },
      // A note card already has a place, so the hidden place chord degrades to
      // the same save as Note. Plain ⌘↵ remains Ask.
      commitFromEnter: noteCommitFromEnter,
      onCommit: function(kind, e){ e.stopPropagation(); finish(kind === "note-window" ? "note" : kind); },
      onLens: function(){} });
    surface.addEventListener("focusout", function(){
      setTimeout(function(){ if (!settled && !surface.contains(document.activeElement)) finish("note"); }, 0);
    });
    grow();
    updateActions();
    editor.focus({ preventScroll: true });
    var caret = (caretOffset == null || caretOffset < 0 || caretOffset > editor.value.length)
      ? editor.value.length : caretOffset;
    editor.setSelectionRange(caret, caret);
    // Setting a textarea selection can scroll an overflow-hidden ancestor even
    // after preventScroll focus. The camera owns this viewport, never DOM scroll.
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
  }
function layoutNode(node){
    var el = node.el; el.style.left = node.x + "px"; el.style.top = node.y + "px"; el.style.width = node.w + "px";
    if (!node.collapsed){
      // Branch cards use their saved/default height as a ceiling, not a floor.
      // Short answers therefore hug their content while longer answers retain
      // the existing scrollable viewport. Keep the root's established fixed
      // document window; it is the canvas anchor rather than a branch.
      if (node._ephemeral && isNoteNode(node) && node.parent_id == null){
        el.style.height = "auto";
        el.style.minHeight = DEFAULT_STANDALONE_NOTE.h + "px";
        el.style.maxHeight = node.h + "px";
      } else if (node.id === rootId || (isNoteNode(node) && node.parent_id == null)){
        el.style.height = node.h + "px";
        el.style.minHeight = "";
        el.style.maxHeight = "";
      } else {
        el.style.height = "auto";
        el.style.minHeight = "";
        el.style.maxHeight = node.h + "px";
      }
    }
  }

  // Shared pointer-gesture wiring: cleans up on pointerup AND pointercancel/
  // lostpointercapture, so an interrupted gesture (touch cancel, window blur)
  // never leaves move listeners or drag state stuck.
  function onPointerGesture(handle, onDown, onMove, onUp, scope){
    function pointerDown(e){
      if (!onDown(e)) return;
      try { handle.setPointerCapture(e.pointerId); } catch(_e){}
      function move(ev){ if (ev.pointerId === e.pointerId) onMove(ev); }
      function finish(commit){
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", done);
        handle.removeEventListener("pointercancel", done);
        handle.removeEventListener("lostpointercapture", done);
        activePointerGestures.delete(cancel);
        try { handle.releasePointerCapture(e.pointerId); } catch(_e){}
        // onUp runs on every ending, interrupted or not, and is told which it
        // was. A gesture torn down by a pinch takeover has still left the world
        // changed, and whatever it started — a running edge scroll, a grabbing
        // cursor — has to be shut down on that path too, not only on a clean up.
        onUp(commit);
      }
      function done(ev){ if (ev.pointerId === e.pointerId) finish(true); }
      function cancel(){ finish(false); }
      activePointerGestures.add(cancel);
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", done);
      handle.addEventListener("pointercancel", done);
      handle.addEventListener("lostpointercapture", done);
    }
    if (scope) scope.listen(handle, "pointerdown", pointerDown);
    else handle.addEventListener("pointerdown", pointerDown);
  }
  // The head carries the card's own gestures — drag it, double-click to open — but it also
  // holds the controls, and a pointer that lands on one of those is operating the control,
  // not the card. Every head gesture owes that distinction the same answer.
  function onCardControl(e){ return !!e.target.closest(".node-btn, [contenteditable]"); }
  // A card gesture that can outrun the viewport. Two rules make that work:
  //
  // The grab is anchored in world coordinates, not as a running screen delta,
  // so the card is re-derived from wherever the pointer currently points into
  // the world. That is what lets the camera move mid-gesture at all — a screen
  // delta would slide the card out from under the cursor by exactly the pan.
  //
  // And every camera step re-runs that derivation from the *unchanged* pointer,
  // so while the canvas scrolls the card keeps travelling with the cursor.
  function enableCardGesture(node, handle, opts){
    var grabX, grabY, lastX, lastY, scroller = null;
    function place(){
      var w = screenToWorld(lastX, lastY);
      opts.apply(node, w.x - grabX, w.y - grabY);
      layoutNode(node); scheduleEdges();
    }
    onPointerGesture(handle,
      function(e){
        if (e.button !== 0 || !opts.accept(e)) return false;
        e.preventDefault();
        if (opts.stopPropagation) e.stopPropagation();
        canvasLifecycle.hooks.hideAsk();
        var w = screenToWorld(e.clientX, e.clientY);
        var anchor = opts.anchor(node);
        grabX = w.x - anchor.x; grabY = w.y - anchor.y;
        lastX = e.clientX; lastY = e.clientY;
        scroller = createEdgeScroller(visibleCanvasRect, function(dx, dy){
          cancelViewAnimation(); // an in-flight glide would fight the drag
          setViewAdjusted(true);
          view.x += dx; view.y += dy;
          applyTransform();
          place();
        });
        return true;
      },
      function(ev){ lastX = ev.clientX; lastY = ev.clientY; place(); scroller.update(lastX, lastY); },
      function(){
        if (scroller) scroller.stop();
        scroller = null;
        drawEdges();
        canvasLifecycle.hooks.persistNode(node);
      });
  }
  function enableDrag(node, handle){
    enableCardGesture(node, handle, {
      accept: function(e){ return !onCardControl(e); },
      anchor: function(n){ return { x: n.x, y: n.y }; },
      apply: function(n, x, y){ n.x = x; n.y = y; }
    });
  }
  function enableResize(node, handle){
    enableCardGesture(node, handle, {
      stopPropagation: true,
      accept: function(){ return true; },
      anchor: function(n){ return { x: n.x + n.w, y: n.y + n.h }; },
      apply: function(n, x, y){ n.w = Math.max(240, x - n.x); n.h = Math.max(160, y - n.y); }
    });
  }
function applyCollapsedState(node, collapsed){
    if (node.collapsed === collapsed) return false;
    node.collapsed = collapsed;
    if (node.el) node.el.classList.toggle("collapsed", collapsed);
    if (node.collapseBtn) syncCollapseButton(node, node.collapseBtn);
    if (!collapsed && node.el) layoutNode(node);
    return true;
  }
function toggleCollapse(node, deep){
    if (node._ephemeral) return;
    if (deep){ setBranchCollapsed(node, !node.collapsed); return; }
    if (!applyCollapsedState(node, !node.collapsed)) return;
    renderVisibility(); drawEdges(); canvasLifecycle.hooks.persistNode(node);
  }
export function setBranchCollapsed(node, collapsed){
    if (!node || node._ephemeral) return;
    var branch = [];
    function collect(current){ branch.push(current); childrenOf(current.id).forEach(collect); }
    collect(node);
    applyCollapsedRun(branch, collapsed);
  }
  // "Collapse children" means exactly that: every descendant folds and the card
  // you asked from stays as it is. That is the whole difference from "Collapse
  // branch", which is this same walk with the card itself included.
function setChildrenCollapsed(node, collapsed){
    if (!node || node._ephemeral) return;
    var descendants = [];
    function collect(current){ childrenOf(current.id).forEach(function(kid){ descendants.push(kid); collect(kid); }); }
    collect(node);
    applyCollapsedRun(descendants, collapsed);
  }
function applyCollapsedRun(targets, collapsed){
    var changed = targets.filter(function(current){ return applyCollapsedState(current, collapsed); });
    for (var i = 0; i < changed.length; i++) canvasLifecycle.hooks.persistNode(changed[i]);
    renderVisibility(); drawEdges();
  }
export function renderVisibility(){
    var cache = Object.create(null);
    for (var id in nodes){ var n = nodes[id]; if (!n.el) continue; if (n.id === rootId){ n.el.style.display = ""; cache[n.id] = true; continue; } n.el.style.display = isVisible(n, cache) ? "" : "none"; }
  }
var edgeRaf = 0;           // coalesces edge redraws during drag/resize/scroll
export function scheduleEdges(){
    if (edgeRaf) return;
    edgeRaf = requestAnimationFrame(function(){ edgeRaf = 0; drawEdges(); });
  }

  // Effective on-canvas height follows the rendered card: collapsed cards are
  // head-only and short branches may be smaller than their saved height cap.
export function effH(n){ return n.el ? (n.el.offsetHeight || (n.collapsed ? 36 : n.h)) : n.h; }
function clamp(lo, hi, v){ return Math.max(lo, Math.min(hi, v)); }

  // Which side the edge leaves the parent from and enters the child on — chosen
  // by where the child actually sits, so a card dragged left of (or above) its
  // parent gets a sensibly routed arrow instead of one that always exits right.
  function edgeSides(p, n){
    var ph = effH(p), nh = effH(n);
    var dx = (n.x + n.w / 2) - (p.x + p.w / 2);
    var dy = (n.y + nh / 2) - (p.y + ph / 2);
    var fx = dx / ((p.w + n.w) / 2 + 1);
    var fy = dy / ((ph + nh) / 2 + 1);
    if (Math.abs(fx) >= Math.abs(fy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
    return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  }

  // Where an edge leaves its parent: at the inline mark of the exact text the
  // branch was asked from (clamped to the card's visible body while scrolled) —
  // the mark's y for side exits, its x for top/bottom exits — at the composer
  // for follow-ups, or at the side's midpoint as a fallback.
  function edgeStart(p, child, side){
    var ph = effH(p), ax = null, ay = null, anchored = false;
    if (!p.collapsed && p.el && p.bodyEl){
      var mark = p.bodyEl.querySelector('mark[data-child="' + child.id + '"]');
      if (mark){
        var mr = mark.getBoundingClientRect();
        if (mr.height > 0){
          var er = p.el.getBoundingClientRect();
          var br = p.bodyEl.getBoundingClientRect();
          ay = p.y + clamp((br.top - er.top) / view.scale + 10, (br.bottom - er.top) / view.scale - 10,
                           (mr.top + mr.height / 2 - er.top) / view.scale);
          ax = p.x + clamp((br.left - er.left) / view.scale + 10, (br.right - er.left) / view.scale - 10,
                           (mr.left + mr.width / 2 - er.left) / view.scale);
          anchored = true;
        }
      } else if (isFollowup(child)){
        ay = p.y + ph - 22;
      }
    }
    if (side === "right")  return { x: p.x + p.w, y: ay != null ? ay : p.y + ph / 2, anchored: anchored };
    if (side === "left")   return { x: p.x,       y: ay != null ? ay : p.y + ph / 2, anchored: anchored };
    if (side === "bottom") return { x: ax != null ? ax : p.x + p.w / 2, y: p.y + ph, anchored: anchored };
    return { x: ax != null ? ax : p.x + p.w / 2, y: p.y, anchored: anchored };
  }
  function edgeEnd(n, side){
    var nh = effH(n);
    if (side === "left")  return { x: n.x,           y: n.y + nh / 2 };
    if (side === "right") return { x: n.x + n.w,     y: n.y + nh / 2 };
    if (side === "top")   return { x: n.x + n.w / 2, y: n.y };
    return { x: n.x + n.w / 2, y: n.y + nh };
  }
  function ctrlPt(pt, side, d){
    if (side === "right")  return (pt.x + d) + " " + pt.y;
    if (side === "left")   return (pt.x - d) + " " + pt.y;
    if (side === "bottom") return pt.x + " " + (pt.y + d);
    return pt.x + " " + (pt.y - d);
  }

  var edgeEls = {};
  var edgeGeometry = {};
  function ensureEdgeEls(childId){
    var els = edgeEls[childId];
    if (els) return els;
    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("data-child", childId);
    var dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("r", "3");
    dot.setAttribute("data-child", childId);
    edgesSvg.appendChild(path);
    edgesSvg.appendChild(dot);
    edgeEls[childId] = [path, dot];
    return edgeEls[childId];
  }
  function removeEdge(childId){
    var els = edgeEls[childId];
    if (els){
      for (var i = 0; i < els.length; i++) if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
    }
    delete edgeEls[childId];
    delete edgeGeometry[childId];
    delete edgeHl[childId];
  }
  function applyEdgeClasses(childId, path, dot, anchored){
    path.classList.toggle("edge-hl", !!edgeHl[childId]);
    dot.classList.toggle("edge-hl", !!edgeHl[childId]);
    dot.classList.toggle("anchored", !!anchored);
  }
function rebuildEdges(){
    while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
    edgeEls = {};
    edgeGeometry = {};
    drawEdges();
  }
export function drawEdges(){
    var live = {};
    var visCache = Object.create(null);
    function vis(node){ return isVisible(node, visCache); }
    for (var id in nodes){
      var n = nodes[id]; if (!n.parent_id || !n.el) continue; var p = nodes[n.parent_id]; if (!p || !p.el) continue;
      if (!vis(n) || !vis(p)) continue;
      live[n.id] = true;
      var sides = edgeSides(p, n);
      var start = edgeStart(p, n, sides[0]);
      var end = edgeEnd(n, sides[1]);
      var horiz = sides[0] === "left" || sides[0] === "right";
      var reach = Math.max(40, (horiz ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
      var d = "M " + start.x + " " + start.y + " C " + ctrlPt(start, sides[0], reach) + " " + ctrlPt(end, sides[1], reach) + " " + end.x + " " + end.y;
      var geom = {
        d: d,
        cx: String(start.x),
        cy: String(start.y),
        anchored: !!start.anchored
      };
      var els = ensureEdgeEls(n.id);
      var path = els[0], dot = els[1], prev = edgeGeometry[n.id];
      if (!prev || prev.d !== geom.d) path.setAttribute("d", geom.d);
      if (!prev || prev.cx !== geom.cx) dot.setAttribute("cx", geom.cx);
      if (!prev || prev.cy !== geom.cy) dot.setAttribute("cy", geom.cy);
      if (!prev || prev.anchored !== geom.anchored) applyEdgeClasses(n.id, path, dot, geom.anchored);
      else if (!!edgeHl[n.id] !== path.classList.contains("edge-hl")) applyEdgeClasses(n.id, path, dot, geom.anchored);
      edgeGeometry[n.id] = geom;
    }
    for (var childId in edgeEls){
      if (!live[childId]) removeEdge(childId);
    }
    // Whatever moved the edges moved the marks: the margin dots ride along.
    canvasLifecycle.hooks.positionDockedNotes();
  }
  // Highlight state lives here, not just on the elements — edges can be removed
  // and recreated when visibility changes, so hover state needs a stable source.
  var edgeHl = {};
function setEdgeHighlight(childId, on){
    if (on) edgeHl[childId] = true; else delete edgeHl[childId];
    var els = edgeEls[childId];
    if (!els) return;
    for (var i = 0; i < els.length; i++) els[i].classList.toggle("edge-hl", on);
  }
export function clearEdgeHighlight(childId){
    delete edgeHl[childId];
  }
function focusOrigin(node, on){
    if (mode !== "canvas") return;
    setEdgeHighlight(node.id, on);
    var p = node.parent_id ? nodes[node.parent_id] : null;
    if (p && p.bodyEl){
      var marks = p.bodyEl.querySelectorAll('[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
    }
  }
  // Hovering the highlighted text lights up the edge to the branch it spawned.
  function onWorldMouseOver(e){
    transitionMarkGroups(e, true, "mark-hover", setEdgeHighlight);
  }
  function onWorldMouseOut(e){
    transitionMarkGroups(e, false, "mark-hover", setEdgeHighlight);
  }

  function initViewportPan(){
    var sx, sy, ox, oy;
    onPointerGesture(viewport,
      function(e){ if (e.pointerType === "touch" || e.button !== 0 || e.target.closest(".node")) return false; canvasLifecycle.hooks.hideAsk(); cancelViewAnimation(); viewport.classList.add("panning"); sx=e.clientX; sy=e.clientY; ox=view.x; oy=view.y; return true; },
      function(ev){ setViewAdjusted(true); view.x = ox + (ev.clientX - sx); view.y = oy + (ev.clientY - sy); applyTransform(); },
      function(){ viewport.classList.remove("panning"); }, canvasLifecycle.scope);
    initTouchViewportGestures();
  }

  // Touch has an explicit ownership contract:
  // - one finger that starts in a card belongs to the card's native scroller;
  // - one finger that starts on empty canvas pans the world 1:1;
  // - two fingers anywhere own the camera and pinch around their midpoint.
  // Keeping this in one state machine prevents a card drag, browser scroll, and
  // canvas pan from each reacting to a different pointer in the same gesture.
  function initTouchViewportGestures(){
    var touches = new Map();
    var gesture = null;
    var PAN_SLOP = 3;

    function touchPoint(event){
      return { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
    function capture(pointerId){
      try { viewport.setPointerCapture(pointerId); } catch(_e){}
    }
    function release(pointerId){
      try { viewport.releasePointerCapture(pointerId); } catch(_e){}
    }
    function resetTouchGesture(){
      touches.forEach(function(_point, pointerId){ release(pointerId); });
      touches.clear();
      gesture = null;
      viewport.classList.remove("panning", "pinching");
    }
    function beginPan(point, active){
      gesture = { kind: "pan", pointerId: point.id, sx: point.x, sy: point.y,
        ox: view.x, oy: view.y, active: !!active };
      if (active) viewport.classList.add("panning");
    }
    function beginPinch(){
      var pair = Array.from(touches.values()).slice(0, 2);
      if (pair.length < 2) return;
      // A pinch wins over a card-head drag or resize that began with the first
      // finger. Their owned listeners are cancelled before the camera moves.
      activePointerGestures.forEach(function(cancel){ cancel(); });
      canvasLifecycle.hooks.hideAsk();
      cancelViewAnimation();
      capture(pair[0].id); capture(pair[1].id);
      var midX = (pair[0].x + pair[1].x) / 2;
      var midY = (pair[0].y + pair[1].y) / 2;
      var dx = pair[1].x - pair[0].x, dy = pair[1].y - pair[0].y;
      gesture = { kind: "pinch", ids: [pair[0].id, pair[1].id],
        distance: Math.max(1, Math.hypot(dx, dy)), scale: view.scale,
        anchor: screenToWorld(midX, midY) };
      suppressClickUntil = Date.now() + 450;
      viewport.classList.remove("panning");
      viewport.classList.add("pinching");
    }
    function onTouchDown(event){
      if (event.pointerType !== "touch") return;
      // A gesture that begins in a native PDF belongs to that PDF's local
      // zoom/scroll state. The canvas must never join it when finger two lands.
      if (event.target.closest && event.target.closest(".rh-pdf-scroll")) return;
      if (touches.size >= 2){ event.preventDefault(); event.stopPropagation(); return; }
      var point = touchPoint(event);
      touches.set(event.pointerId, point);
      if (touches.size === 2){
        beginPinch();
        event.preventDefault(); event.stopPropagation();
        return;
      }
      if (!(event.target.closest && event.target.closest(".node"))){
        canvasLifecycle.hooks.hideAsk();
        cancelViewAnimation();
        capture(event.pointerId);
        beginPan(point, false);
        event.preventDefault(); event.stopPropagation();
      } else {
        // Do not prevent this pointer: the card body keeps native one-finger
        // scrolling, momentum, text selection, and nested horizontal scrolling.
        gesture = { kind: "content", pointerId: event.pointerId };
      }
    }
    function onTouchMove(event){
      if (event.pointerType !== "touch" || !touches.has(event.pointerId)) return;
      var point = touchPoint(event);
      touches.set(event.pointerId, point);
      if (!gesture) return;
      if (gesture.kind === "pinch"){
        var a = touches.get(gesture.ids[0]), b = touches.get(gesture.ids[1]);
        if (!a || !b) return;
        var dx = b.x - a.x, dy = b.y - a.y;
        var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
          gesture.scale * Math.hypot(dx, dy) / gesture.distance));
        var midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        setViewAdjusted(true);
        view.scale = next;
        view.x = midX - gesture.anchor.x * next;
        view.y = midY - gesture.anchor.y * next;
        applyTransform();
        event.preventDefault(); event.stopPropagation();
        return;
      }
      if (gesture.kind === "pan" && gesture.pointerId === event.pointerId){
        var panX = point.x - gesture.sx, panY = point.y - gesture.sy;
        if (!gesture.active && Math.hypot(panX, panY) < PAN_SLOP) return;
        if (!gesture.active){
          gesture.active = true;
          viewport.classList.add("panning");
          suppressClickUntil = Date.now() + 350;
        }
        setViewAdjusted(true);
        view.x = gesture.ox + panX;
        view.y = gesture.oy + panY;
        applyTransform();
        event.preventDefault(); event.stopPropagation();
      }
    }
    function onTouchEnd(event){
      if (event.pointerType !== "touch" || !touches.has(event.pointerId)) return;
      release(event.pointerId);
      touches.delete(event.pointerId);
      if (gesture && gesture.kind === "pinch" && touches.size === 1){
        // Lifting one finger after a pinch should flow directly into a one-finger
        // camera pan instead of dropping the gesture or jumping the world.
        var remaining = Array.from(touches.values())[0];
        viewport.classList.remove("pinching");
        capture(remaining.id);
        beginPan(remaining, true);
        event.preventDefault(); event.stopPropagation();
        return;
      }
      if (!touches.size || (gesture && gesture.pointerId === event.pointerId)) resetTouchGesture();
    }
    function onTouchCancel(event){
      if (event.pointerType !== "touch") return;
      release(event.pointerId);
      touches.delete(event.pointerId);
      resetTouchGesture();
    }
    function suppressGestureClick(event){
      if (Date.now() >= suppressClickUntil) return;
      event.preventDefault(); event.stopPropagation();
    }

    var scope = canvasLifecycle.scope;
    scope.listen(viewport, "pointerdown", onTouchDown, { capture: true, passive: false });
    scope.listen(viewport, "pointermove", onTouchMove, { capture: true, passive: false });
    scope.listen(viewport, "pointerup", onTouchEnd, { capture: true, passive: false });
    scope.listen(viewport, "pointercancel", onTouchCancel, { capture: true, passive: false });
    scope.listen(viewport, "click", suppressGestureClick, true);
    scope.addCleanup(resetTouchGesture);
  }

  // Can this element still scroll in the direction of the wheel delta?
  function canScroll(el, dx, dy){
    if (dx && el.scrollWidth > el.clientWidth + 1){
      if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    if (dy && el.scrollHeight > el.clientHeight + 1){
      if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    }
    return false;
  }
  // A trackpad swipe is one gesture and keeps the target it STARTED on: a pan
  // begun on the background stays a pan while the cursor crosses cards, and a
  // scroll begun inside a card keeps scrolling that card — never the canvas —
  // even if the cursor drifts off it. A pause in wheel events ends the gesture.
  var wheelKind = null, wheelCard = null, wheelTs = 0;
  function onViewportWheel(e){
    if (e.ctrlKey){ e.preventDefault(); wheelKind = null; zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); return; }
    if (!wheelKind || e.timeStamp - wheelTs > 180){
      wheelCard = (e.target.closest && e.target.closest(".node")) || null;
      wheelKind = wheelCard ? "card" : "pan";
    }
    wheelTs = e.timeStamp;
    if (wheelKind === "pan"){
      e.preventDefault(); cancelViewAnimation(); setViewAdjusted(true); view.x -= e.deltaX; view.y -= e.deltaY; applyTransform();
      return;
    }
    var over = (e.target.closest && e.target.closest(".node")) || null;
    if (over !== wheelCard){
      // Drifted off the origin card mid-scroll: keep moving ITS content by hand.
      e.preventDefault();
      var nb = wheelCard ? wheelCard.querySelector(".node-body") : null;
      if (nb){ nb.scrollLeft += e.deltaX; nb.scrollTop += e.deltaY; }
      return;
    }
    // Still over the origin card: allow the browser to scroll the innermost thing
    // that can still move (body, a code block, a wide table); if nothing can,
    // swallow the event so the canvas doesn't lurch mid-read.
    var el = e.target, consumable = false;
    while (el && el.nodeType === 1){
      if (canScroll(el, e.deltaX, e.deltaY)){ consumable = true; break; }
      if (el === over) break;
      el = el.parentNode;
    }
    if (!consumable) e.preventDefault();
  }

export function frameAll(animate, source){
    var visCache = Object.create(null);
    var ids = Object.keys(nodes).filter(function(id){
      var node = nodes[id];
      var emptyDraft = node._ephemeral && !node._noteEditor?.value.trim() && !node._noteAttachments?.length && !node._notePastePending;
      return !emptyDraft && !isDockedNote(node) && isVisible(node, visCache);
    });
    if (!ids.length) return;
    var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    ids.forEach(function(id){ var n=nodes[id]; minX=Math.min(minX,n.x); minY=Math.min(minY,n.y); maxX=Math.max(maxX,n.x+n.w); maxY=Math.max(maxY,n.y+effH(n)); });
    var r=visibleCanvasRect(), pad=100;
    var vw=r.width, vh=r.height;
    var ts = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((vw-pad)/(maxX-minX), (vh-pad)/(maxY-minY), 1.2)));
    var tx = r.left+vw/2 - (minX+(maxX-minX)/2)*ts, ty = r.top+vh/2 - (minY+(maxY-minY)/2)*ts;
    if (source) setViewAdjusted(true);
    if (animate){ animateView(tx, ty, ts, { source: source, duration: 270, ease: "inOut" }); return; }
    view.scale = ts; view.x = tx; view.y = ty; applyTransform();
  }
export function createStandaloneNoteAtViewportCenter(){
    var r = visibleCanvasRect();
    createStandaloneNoteAtScreen(
      r.left + r.width / 2 - DEFAULT_STANDALONE_NOTE.w * view.scale / 2,
      r.top + r.height / 2 - DEFAULT_STANDALONE_NOTE.h * view.scale / 2
    );
  }
  function createStandaloneNoteAtScreen(sx, sy){
    if (mode !== "canvas" || document.body.classList.contains("mode-flight") || frozen || closed) return null;
    cancelViewAnimation();
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
    var point = screenToWorld(sx, sy);
    var node = registerNode({
      id: uuid(), parent_id: null, title: "Note", html: "", md: "",
      base_url: null, base_url_source: null, read: true, origin: { kind: "note" },
      x: point.x, y: point.y,
      w: DEFAULT_STANDALONE_NOTE.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
      status: "answered", _order: nextOrder(), _startTs: 0, extensions: {}, _ephemeral: true
    });
    // The cursor should land on an exact, stable canvas point immediately;
    // type-to-grow must never inherit the branch-card entrance translation.
    createNodeEl(node, false);
    renderVisibility(); drawEdges();
    startNoteEditing(node, node.bodyEl.querySelector(".doc-content"));
    return node;
  }
  function onViewportDblClick(e){
    if (Date.now() < suppressClickUntil) return;
    if (e.target.closest && e.target.closest(".node")) return;
    createStandaloneNoteAtScreen(e.clientX, e.clientY);
  }

export function tidy(source){
    var visited={};
    function moveSubtree(node, dx, dy){
      node.x += dx; node.y += dy;
      placedChildren(node.id).filter(function(k){ return visited[k.id]; }).sort(nodeOrder).forEach(function(k){ moveSubtree(k, dx, dy); });
    }
    function place(node, x, y){
      visited[node.id] = true;
      node.x = x; node.y = y;
      var bounds = nodeBounds(node, { effH: effH });
      if (node.collapsed) return bounds;

      var kids = placedChildren(node.id).sort(nodeOrder);
      var selectionKids = kids.filter(isSelectionBranch);
      var followupKids = kids.filter(isFollowup);
      var sideBounds = null;
      var sideX = node.x + node.w + TREE_PARENT_GAP;
      var sideY = node.y;
      selectionKids.forEach(function(k){
        var kb = place(k, sideX, sideY);
        sideBounds = unionBounds(sideBounds, kb);
        bounds = unionBounds(bounds, kb);
        sideY = kb.maxY + TREE_STACK_GAP;
      });

      var belowY = node.y + effH(node) + TREE_PARENT_GAP;
      followupKids.forEach(function(k){
        var kb = place(k, node.x, belowY);
        if (boundsOverlap(kb, sideBounds)){
          var dy = sideBounds.maxY + TREE_STACK_GAP - kb.minY;
          moveSubtree(k, 0, dy);
          kb = shiftBounds(kb, 0, dy);
        }
        bounds = unionBounds(bounds, kb);
        belowY = kb.maxY + TREE_STACK_GAP;
      });
      return bounds;
    }
    var root = nodes[rootId]; if (!root) return; place(root, 0, 0);
    // Only nodes actually visited (the visible tree) are laid out — hidden
    // descendants of a collapsed node keep their positions instead of being
    // yanked around by a stale traversal.
    var ids = Object.keys(visited);
    var moved = [];
    ids.forEach(function(id){ var nn=nodes[id]; layoutNode(nn); moved.push(nn); });
    canvasLifecycle.hooks.persistNodesBulk(moved);
    rebuildEdges(); frameAll(true, source);
  }

  // Canvas cards (DOM + rendered markdown for every node) are built on first
  // canvas entry — with canvas as the landing surface that is effectively at
  // hydrate, but the guard keeps re-entry and programmatic callers cheap.
function ensureCanvasBuilt(){
    if (canvasBuilt) return;
    setCanvasBuilt(true);
    // Docked notes get no card: they are drawn onto their parent's, which
    // fillBody does as each card is built.
    Object.keys(nodes).forEach(function(id){ if (!nodes[id].el && !isDockedNote(nodes[id])) createNodeEl(nodes[id]); });
    renderVisibility();
    applyTransform();
  }
export function setMode(m){
    var transferredPosition = null;
    var fromReader = m === "canvas" && mode === "reader";
    if (fromReader){
      // display:none resets the reader's scrollTop — remember it first so
      // collapsing out to the canvas and diving back lands exactly where you were.
      var cur = nodes[currentNodeId];
      if (cur) {
        cur._scrollTop = readerMain.scrollTop;
        transferredPosition = captureContentPosition(readerMain);
      }
    }
    setModeValue(m);
    if (m === "canvas"){
      ensureCanvasBuilt();
      document.body.classList.add("mode-canvas");
      // Settle the reader back toward the card it is. If the card still sits
      // in view, the camera stays put (macOS restore: the window returns to
      // its spot). If the human panned away — or dove into a different branch
      // while reading — the camera jumps home NOW, while the opaque reader
      // still covers the canvas: the jump is invisible, the card is already
      // seated when the fade reveals it, and there is nothing to keep in sync.
      if (fromReader){
        var target = nodes[currentNodeId];
        var rect = null;
        if (target && isVisible(target)){
          rect = cardScreenRect(target);
          if (!rectMostlyVisible(rect)){
            var pose = diveTargetView(target);
            animateView(pose.x, pose.y, pose.scale, { source: "flight" });
            rect = cardScreenRect(target);
          }
        }
        var flew = flyReaderToRect(rect);
        if (target && target.el){
          // The flash confirms the landing, so it waits for the fade to
          // finish; under the fading sheet it reads as a glitch.
          var cueEl = target.el;
          if (flew) document.addEventListener("rh-reader-flight-end", function(){ playLandingCue(cueEl, "flash"); }, { once: true });
          else playLandingCue(cueEl, "flash");
        }
      }
      requestAnimationFrame(function(){
        var active = nodes[currentNodeId];
        if (transferredPosition && active?.bodyEl) restoreContentPosition(active.bodyEl, transferredPosition);
        rebuildEdges();
        // Frame everything only the first time; afterwards the canvas keeps the
        // pan/zoom you left it at.
        if (!canvasFramed){ setCanvasFramed(true); frameAll(); }
      });
      canvasLifecycle.hooks.scheduleViewSave();
    }
    else { openNode(currentNodeId); }
  }
