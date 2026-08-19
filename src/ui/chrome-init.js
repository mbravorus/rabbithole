import {
  currentNodeId,
  flashHint,
  mode,
  nodes,
} from "./core.js";
import { focusedMark, jumpToOrigin, openNode, stepMark } from "./reader.js";
import { setMode, tidy } from "./canvas-view.js";
import { togglePalette } from "./palette.js";
import { hydrateInitialState } from "./hydrate.js";
import { createCleanupScope } from "./lifecycle.js";
import { applyTheme } from "./preferences.js";
import { isSettingsSheetOpen } from "./settings-sheet.js";

var chromeScope = null;

  // ===========================================================================
  // chrome (theme, hint, keys)
  // ===========================================================================
export function initChrome(options){
  disposeChrome();
  chromeScope = createCleanupScope();
  chromeScope.listen(document, "keydown", onGlobalKeydown);
  try {
    applyInitialTheme();
    hydrateInitialState(options || {});
  } catch (error) {
    disposeChrome();
    throw error;
  }
  return disposeChrome;
}

export function disposeChrome(){
  var scope = chromeScope;
  chromeScope = null;
  if (scope) scope.dispose();
}

function onGlobalKeydown(e){
    // ⌘K works everywhere, even from inside a textarea — it's the escape hatch.
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")){
      e.preventDefault();
      togglePalette();
      return;
    }
    if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return;
    if (e.key === "?"){
      flashHint(mode === "canvas"
        ? "space — open the current card · t tidy · ⌘K search and commands"
        : "j / k — walk the highlights · ↵ open · ⌫ up a level · esc — back to canvas · ⌘K search");
      return;
    }
    // Esc always collapses the focused state back onto the canvas — the same
    // muscle memory as leaving full screen. Popovers get first claim on it.
    if (e.key === "Escape" && mode === "reader" && !overlayOpen()){ setMode("canvas"); return; }
    if ((e.key === "t" || e.key === "T") && mode === "canvas"){ tidy("keyboard"); return; }
    // Quick Look: space expands the current card into the reader.
    if (e.key === " " && mode === "canvas"){
      if (e.target === document.body || e.target === document.documentElement || e.target.id === "viewport" || e.target.id === "canvas-gesture-plane"){
        e.preventDefault();
        openNode(currentNodeId);
      }
      return;
    }
    if (mode !== "reader") return;
    // Reading is keyboard-shaped; branching is too: j/k walk the marks in this
    // document, ↵ dives into the focused branch, ⌫ surfaces to the parent —
    // and past the root, out to the canvas.
    if (e.key === "j" || e.key === "k"){ e.preventDefault(); stepMark(e.key === "j" ? 1 : -1); }
    else if (e.key === "Enter"){
      var m = focusedMark();
      if (m){ e.preventDefault(); var kid = nodes[m.dataset.child]; if (kid) openNode(kid.id); }
    }
    else if (e.key === "Backspace"){
      var cur = nodes[currentNodeId];
      if (cur && cur.parent_id && nodes[cur.parent_id]){ e.preventDefault(); jumpToOrigin(cur, "keyboard"); }
      else { e.preventDefault(); setMode("canvas"); }
    }
}

// Any open popover owns Escape; leaving the reader is only ever the last resort.
function overlayOpen(){
  var palette = document.getElementById("palette");
  if (palette && !palette.hidden) return true;
  if (isSettingsSheetOpen()) return true;
  var surfaces = ["ask", "sharemenu", "cardmenu", "notepop"];
  for (var i = 0; i < surfaces.length; i++){
    var el = document.getElementById(surfaces[i]);
    if (el && el.classList.contains("visible")) return true;
  }
  return false;
}

  // An explicit light/dark choice wins; otherwise the page follows the system
  // preference and keeps following it while it stays on "system".
function applyInitialTheme(){
  try { applyTheme(); } catch(e){}
}
