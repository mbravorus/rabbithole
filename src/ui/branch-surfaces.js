import {
  canvasBuilt,
  childrenOf,
  currentNodeId,
  flashHint,
  frozen,
  closed,
  mode,
  nodes,
  postBrowserEvent,
  readerMain,
  rootId,
  setCurrentNodeId,
  shareMenu
} from "./core.js";
import { isDockedNote, lensLabel, lineageNodesFromMap, truncate } from "../core/model.js";
import {
  clearEdgeHighlight,
  createNodeEl,
  drawEdges,
  fillBody,
  renderVisibility
} from "./canvas-view.js";
import {
  openNode,
  renderBreadcrumb,
  renderMarginNotes,
  renderReaderBody
} from "./reader.js";
import { createAnchoredMenu } from "./primitives/anchored-menu.js";
import { wireNotice } from "./primitives/notice.js";
import { createModuleLifecycle } from "./lifecycle.js";
import { detachNode, teardownNode } from "./node-teardown.js";
import { removeMarks } from "./text-marks.js";

function defaultBranchHooks(){
  return {
    exportSnapshot: null,
    exportPortable: null
  };
}

var branchLifecycle = createModuleLifecycle({ defaults: defaultBranchHooks });
var pendingRemoval = null;
var undoNotice = null;
var shareMenuController = null;

export function registerBranchHooks(hooks) {
  branchLifecycle.register(hooks);
}

  // ===========================================================================
  // MARKS ARE LINKS — a mark takes you to its branch, nothing hovers over it.
  // The click/Enter wiring lives with the marks in reader.js.
  // ===========================================================================
export function initBranchSurfaces(){
  disposeBranchSurfaceResources(false);
  var branchScope = branchLifecycle.beginInit();
  try {
  shareMenuController = createAnchoredMenu({ surface: shareMenu, placement: "bottom-end" });
  branchScope.addCleanup(function(){ shareMenuController?.dispose(); shareMenuController = null; });
  branchScope.listen(document.getElementById("t-share"), "click", function(e){ e.stopPropagation(); toggleShare(e.currentTarget, e.detail === 0); });
  branchScope.listen(document.getElementById("sm-doc"), "click", onCopyDoc);
  branchScope.listen(document.getElementById("sm-trail"), "click", onCopyTrail);
  branchScope.listen(document.getElementById("sm-export"), "click", onExportSnapshot);
  branchScope.listen(document.getElementById("sm-portable"), "click", onExportPortable);
  undoNotice = wireNotice(document.getElementById("branch-undo"), { variant: "toast" });
  branchScope.listen(document, "keydown", onUndoKeydown);
  return disposeBranchSurfaces;
  } catch (error) {
    disposeBranchSurfaces();
    throw error;
  }
}

export function disposeBranchSurfaces(){
  disposeBranchSurfaceResources(true);
}

function disposeBranchSurfaceResources(resetHooks){
  if (pendingRemoval) commitPendingBranchRemoval();
  if (undoNotice) undoNotice.hide();
  closeShare({ restoreFocus: false });
  branchLifecycle.dispose(resetHooks);
  shareMenuController = null;
  undoNotice = null;
}


  // ===========================================================================
  // SHARE — export and copy as Markdown
  // ===========================================================================
function toggleShare(anchor, openedByKeyboard){
    // A frozen snapshot can't export because it is the export.
    document.getElementById("sm-export").style.display = frozen ? "none" : "";
    document.getElementById("sm-portable").style.display = (!frozen && typeof branchLifecycle.hooks.exportPortable === "function") ? "" : "none";
    shareMenuController.toggle(anchor, { focusFirst: openedByKeyboard });
  }
export function closeShare(settings){
    if (shareMenuController) shareMenuController.close(settings);
  }

  function copyText(text, okMsg){
    function done(){ flashHint(okMsg); }
    function copyWithTextarea(){
      var previousFocus = document.activeElement;
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch(err){}
      document.body.removeChild(ta);
      if (previousFocus && previousFocus.isConnected){
        try { previousFocus.focus(); } catch(err){}
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, function(){ copyWithTextarea(); done(); });
    } else { copyWithTextarea(); done(); }
  }
  // Markdown reconstructions — the raw source rides in hydration/broadcasts.
  function originLine(n){
    if (!n.origin) return "";
    var ask = n.origin.lens ? lensLabel(n.origin.lens) : (n.origin.question || "");
    if (n.origin.selected_text) return "> Asked about: “" + n.origin.selected_text + "”" + (ask ? " — " + ask : "") + "\n\n";
    return ask ? "> Follow-up — " + ask + "\n\n" : "";
  }
  function docMarkdown(n, depth){
    var h = "#";
    for (var i = 0; i < Math.min(depth, 3); i++) h += "#";
    var body = (n.md || "").trim() || "_(still being written)_";
    return h + " " + (n.title || "Untitled") + "\n\n" + originLine(n) + body + "\n";
  }
  function trailMarkdown(id){
    var path = lineageNodesFromMap(nodes, id), parts = [];
    for (var i = 0; i < path.length; i++) parts.push(docMarkdown(path[i], i));
    return parts.join("\n---\n\n");
  }
  function onCopyDoc(){
    closeShare();
    copyNodeMarkdown(nodes[currentNodeId]);
  }
export function copyNodeMarkdown(n){
    if (!n) return;
    copyText(docMarkdown(n, 0), "Copied “" + truncate(n.title || "Untitled", 40) + "” as Markdown");
  }
  function onCopyTrail(){
    closeShare();
    var path = lineageNodesFromMap(nodes, currentNodeId);
    copyText(trailMarkdown(currentNodeId), path.length === 1
      ? "Copied this document as Markdown"
      : "Copied the trail — " + path.length + " documents");
  }
	  function onExportSnapshot(){
	    closeShare();
	    if (typeof branchLifecycle.hooks.exportSnapshot !== "function"){
	      flashHint("This snapshot is already portable.");
	      return;
	    }
	    flashHint("Preparing snapshot...");
	    Promise.resolve(branchLifecycle.hooks.exportSnapshot()).then(function(){
	      flashHint("Snapshot downloading — a single file that opens anywhere.");
	    }, function(){
	      flashHint("Couldn't prepare the snapshot.");
	    });
	  }
  function onExportPortable(){
    closeShare();
    if (typeof branchLifecycle.hooks.exportPortable !== "function"){
      flashHint("Rabbithole export is only available in the web app.");
      return;
    }
    flashHint("Preparing Rabbithole export...");
    Promise.resolve()
      .then(function(){ return branchLifecycle.hooks.exportPortable(); })
      .then(function(result){
        var name = result && result.filename ? " " + result.filename : "";
        flashHint("Rabbithole export downloading." + name);
      }, function(){
        flashHint("Couldn't prepare the Rabbithole export.");
      });
  }
  // ===========================================================================
  // DELETE — remove a branch now; keep one exact local undo until the toast expires.
  // ===========================================================================
export function removeBranch(node){
    if (!node || node.id === rootId) return;
    if (node._ephemeral){
      removeNodesLocal([node.id], node.parent_id);
      return;
    }
    if (closed){
      flashHint(frozen ? "This is a read-only snapshot." : "Session ended — changes can't be saved anymore.");
      return;
    }
    if (pendingRemoval) commitPendingBranchRemoval();
    var ids = collectSubtree(node.id, []);
    var previousCurrentId = currentNodeId;
    pendingRemoval = { rootId: node.id, parentId: node.parent_id, ids: ids, previousCurrentId: previousCurrentId };
    for (var i = 0; i < ids.length; i++){
      var staged = nodes[ids[i]];
      if (staged) staged._pendingDelete = true;
    }
    for (var j = 0; j < ids.length; j++){
      var stagedNode = nodes[ids[j]];
      if (!stagedNode) continue;
      clearEdgeHighlight(stagedNode.id);
      removeMarks(readerMain, stagedNode.id);
      var parent = nodes[stagedNode.parent_id];
      if (parent && parent.bodyEl) removeMarks(parent.bodyEl, stagedNode.id);
      detachNode(stagedNode);
    }
    var currentGone = ids.indexOf(currentNodeId) !== -1;
    if (currentGone) setCurrentNodeId((node.parent_id && nodes[node.parent_id]) ? node.parent_id : rootId);
    refreshAfterRemoval(node.parent_id, currentGone);
    undoNotice.show({ message: "Branch removed", actionLabel: "Undo", onAction: undoPendingRemoval,
      onExpire: commitPendingBranchRemoval, duration: 6000 });
  }
  function onUndoKeydown(e){
    if (!pendingRemoval || !undoNotice?.isVisible() || !(e.metaKey || e.ctrlKey) || e.shiftKey || String(e.key).toLowerCase() !== "z") return;
    e.preventDefault();
    undoPendingRemoval();
    undoNotice.hide();
  }
  function collectSubtree(id, out){
    out.push(id);
    childrenOf(id).forEach(function(k){ collectSubtree(k.id, out); });
    return out;
  }
  function undoPendingRemoval(){
    var removal = pendingRemoval;
    if (!removal) return;
    pendingRemoval = null;
    for (var i = 0; i < removal.ids.length; i++){
      var node = nodes[removal.ids[i]];
      if (node) delete node._pendingDelete;
    }
    if (nodes[removal.previousCurrentId]) setCurrentNodeId(removal.previousCurrentId);
    if (canvasBuilt){
      for (var j = 0; j < removal.ids.length; j++){
        var restored = nodes[removal.ids[j]];
        // A docked note comes back onto its parent's margin, never as a card.
        if (restored && !restored.el && !isDockedNote(restored)) createNodeEl(restored, true);
      }
    }
    refreshAfterRemoval(removal.parentId, false);
    if (mode === "reader" && nodes[removal.previousCurrentId]) openNode(removal.previousCurrentId);
  }
export function commitPendingBranchRemoval(){
    var removal = pendingRemoval;
    if (!removal) return Promise.resolve({ ok: true });
    pendingRemoval = null;
    if (undoNotice) undoNotice.hide();
    var request = postBrowserEvent({ type: "delete_node", node_id: removal.rootId });
    removeNodesLocal(removal.ids, removal.parentId);
    return Promise.resolve(request);
  }
  function refreshAfterRemoval(parentId, currentGone){
    var parent = parentId && nodes[parentId];
    if (parent && parent.bodyEl){
      var scrollTop = parent.bodyEl.scrollTop;
      fillBody(parent);
      parent.bodyEl.scrollTop = scrollTop;
    }
    if (canvasBuilt){ renderVisibility(); drawEdges(); }
    if (mode === "reader"){
      if (currentGone) openNode(currentNodeId);
      else {
        if (currentNodeId === parentId) renderReaderBody();
        renderBreadcrumb(); renderMarginNotes();
      }
    }
  }
export function removeNodesLocal(ids, parentId){
    if (pendingRemoval && ids.indexOf(pendingRemoval.rootId) !== -1){
      pendingRemoval = null;
      if (undoNotice) undoNotice.hide();
    }
    var currentGone = false;
    for (var i = 0; i < ids.length; i++){
      var id = ids[i], n = nodes[id];
      if (!n) continue;
      if (currentNodeId === id) currentGone = true;
      clearEdgeHighlight(id);
      teardownNode(id);
    }
    if (currentGone){
      setCurrentNodeId((parentId && nodes[parentId]) ? parentId : rootId);
      if (mode === "reader") openNode(currentNodeId);
    }
    if (canvasBuilt){ renderVisibility(); drawEdges(); }
    if (mode === "reader"){ renderBreadcrumb(); renderMarginNotes(); }
  }
