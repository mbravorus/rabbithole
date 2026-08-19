import { disposeNodeContent, nodes, readerMain, unregisterNode } from "./core.js";
import { removeMarks } from "./text-marks.js";

/** @param {Record<string, any>} node */
export function detachNode(node) {
  if (!node) return;
  if (node._noteDraftDispose) node._noteDraftDispose();
  disposeNodeContent(node);
  if (node.el && node.el.parentNode) node.el.parentNode.removeChild(node.el);
  node.el = null;
  node.bodyEl = null;
  node.titleEl = null;
  node.actsEl = null;
  node.actDivider = null;
  node.moreBtn = null;
  node.collapseBtn = null;
  node.ncComp = null;
  node.ncInner = null;
  node.ncText = null;
  node.ncActions = null;
  node.ncHandle = null;
  node._noteEditor = null;
  node._noteEditSurface = null;
  node._noteComposer = null;
  node._noteActions = null;
  node._noteInput = null;
  node._noteAttachmentStrip = null;
  node._noteAttachments = null;
  node._noteUploadedAssets = null;
  node._noteUploading = false;
  node._noteNormalizing = false;
  node._notePastePending = 0;
  node._noteDraftDispose = null;
  node._noteDockedComposer = null;
  node._noteConversionRollback = null;
}

/** @param {string} id */
export function teardownNode(id) {
  var node = nodes[id];
  if (!node) return;
  detachNode(node);
  removeMarks(readerMain, id);
  var parent = nodes[node.parent_id];
  if (parent && parent.bodyEl) removeMarks(parent.bodyEl, id);
  unregisterNode(id);
}
