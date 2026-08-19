import {
  MAX_SCALE,
  MIN_SCALE,
  frozen,
  hydration,
  nextOrder,
  nodes,
  registerNode,
  rootId,
  setCanvasFramed,
  setCurrentNodeId,
  setViewAdjusted,
  view
} from "./core.js";
import { DEFAULT_CHILD, DEFAULT_ROOT, DEFAULT_STANDALONE_NOTE } from "../core/layout.js";
import { isNoteNode } from "../core/model.js";
import { setMode } from "./canvas-view.js";
import { setRendererAssetData } from "./renderer.js";

export function hydrateInitialState({ connectSse = null, refreshStatus = null } = {}) {
  setRendererAssetData(hydration.asset_data || null);
  if (frozen) document.body.classList.add("frozen");
  (hydration.nodes || []).forEach(function(raw){
    var isRoot = raw.id === rootId;
    var size = raw.size || (isRoot ? DEFAULT_ROOT : (isNoteNode(raw) && raw.parent_id == null ? DEFAULT_STANDALONE_NOTE : DEFAULT_CHILD));
    registerNode({
      id: raw.id, parent_id: raw.parent_id, title: raw.title,
      html: "", md: raw.markdown || "",
      base_url: raw.base_url || null, base_url_source: raw.base_url_source || null,
      read: !!raw.read, origin: raw.origin,
      x: (raw.position && raw.position.x) || 0, y: (raw.position && raw.position.y) || 0,
      w: size.w, h: size.h, font_scale: raw.font_scale || 1, collapsed: !!raw.collapsed,
      status: raw.status || "answered", _order: 0,
      extensions: raw.extensions || {},
      _startTs: (raw.status === "pending") ? Date.now() : 0
    });
  });
  Object.keys(nodes).forEach(function(id){ nodes[id]._order = nextOrder(); });
  // Land exactly where the human left off: same current document, same scroll,
  // same canvas framing. A first open starts at the root like always.
  var vs = hydration.view_state;
  if (vs && vs.node_id && nodes[vs.node_id]){
    setCurrentNodeId(vs.node_id);
    if (vs.scroll) nodes[vs.node_id]._scrollTop = vs.scroll;
  }
  if (vs && vs.view){
    view.x = vs.view.x; view.y = vs.view.y;
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vs.view.scale || 1));
    setCanvasFramed(true); // the saved framing wins; don't re-frame on first entry
    setViewAdjusted(true); // keep an existing user view in later state saves
  }
  // Canvas is home: every entry lands on the map, whatever mode was up when
  // the hole closed. The reader is a focus state — you re-enter it by
  // expanding the current card, which still remembers its scroll position.
  setMode("canvas");
  if (typeof refreshStatus === "function") refreshStatus();
  if (!frozen && typeof connectSse === "function") connectSse();
}
