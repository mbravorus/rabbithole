import { setSurfaceOrigin } from "../core.js";
import { registerLayer } from "./layer-stack.js";

function tokenPx(surface, name) {
  var value = parseFloat(getComputedStyle(surface).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

function viewportRect() {
  var viewport = window.visualViewport;
  return { left: viewport ? viewport.offsetLeft : 0, top: viewport ? viewport.offsetTop : 0,
    width: viewport ? viewport.width : window.innerWidth, height: viewport ? viewport.height : window.innerHeight };
}

function clampToViewport(value, min, max) {
  // An on-screen keyboard or browser zoom can make a surface temporarily
  // larger than the visual viewport. Keep its leading edge reachable instead
  // of letting the usual clamp push that edge off-screen.
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function oppositeSide(side) {
  return side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
}

// An open surface keeps the side it opened on. Anchors wobble by fractions of
// a pixel — hover transforms, streaming re-measures, dot repositioning — and a
// naive side flip near the threshold teleports the surface across its anchor.
// Only a real shortfall beyond this margin earns a flip after opening.
var FLIP_HYSTERESIS = 8;

export function anchorSurface(trigger, surface, options) {
  options = options || {};
  var contextElement = trigger && trigger.contextElement;
  var observedTrigger = contextElement || trigger;
  var virtual = !!contextElement || !(trigger instanceof Element);
  var placement = options.placement || "bottom-end", disposed = false, frame = 0, updating = false;
  var lastLeft = null, lastTop = null, settledSide = null;

  function updateNow() {
    frame = 0;
    if (disposed || !surface.isConnected || (virtual ? contextElement && !contextElement.isConnected : !trigger.isConnected)) return;
    updating = true;
    var viewport = viewportRect();
    // CSS viewport units describe the layout viewport on iOS, which does not
    // reliably shrink for the software keyboard. Expose the visual viewport so
    // scrollable overlays can size themselves to the space actually available.
    surface.style.setProperty("--overlay-viewport-width", viewport.width + "px");
    surface.style.setProperty("--overlay-viewport-height", viewport.height + "px");
    var anchor = trigger.getBoundingClientRect(), box = surface.getBoundingClientRect();
    // A 0×0 anchor at the origin is a dead anchor (collapsed range, detached
    // node) — hold the last good position rather than glide to the corner.
    if (!anchor.width && !anchor.height && !anchor.left && !anchor.top && lastLeft !== null) { updating = false; return; }
    var edge = tokenPx(surface, "--surface-edge"), gap = tokenPx(surface, "--surface-gap");
    var parts = placement.split("-"), side = parts[0], align = parts[1] || "center";
    var left, top;
    if (side === "center") {
      left = viewport.left + (viewport.width - box.width) / 2;
      top = viewport.top + (viewport.height - box.height) / 2;
    } else {
      var vertical = side === "top" || side === "bottom";
      // Sticky side: once a side has been settled on, keep preferring it.
      if (settledSide === side || settledSide === oppositeSide(side)) side = settledSide;
      var before = vertical ? anchor.top - viewport.top : anchor.left - viewport.left;
      var after = vertical ? viewport.top + viewport.height - anchor.bottom : viewport.left + viewport.width - anchor.right;
      var mainSize = vertical ? box.height : box.width;
      var preferredSpace = side === "top" || side === "left" ? before : after;
      var alternateSpace = side === "top" || side === "left" ? after : before;
      var slack = settledSide === side ? FLIP_HYSTERESIS : 0;
      if (preferredSpace + slack < mainSize + gap + edge && alternateSpace > preferredSpace) {
        side = oppositeSide(side);
      }
      settledSide = side;
      if (side === "top" || side === "bottom") {
        top = side === "bottom" ? anchor.bottom + gap : anchor.top - box.height - gap;
        left = align === "start" ? anchor.left : align === "end" ? anchor.right - box.width : anchor.left + (anchor.width - box.width) / 2;
      } else {
        left = side === "right" ? anchor.right + gap : anchor.left - box.width - gap;
        top = align === "start" ? anchor.top : align === "end" ? anchor.bottom - box.height : anchor.top + (anchor.height - box.height) / 2;
      }
    }
    left = clampToViewport(left, viewport.left + edge, viewport.left + viewport.width - edge - box.width);
    top = clampToViewport(top, viewport.top + edge, viewport.top + viewport.height - edge - box.height);
    if (left !== lastLeft) surface.style.left = left + "px";
    if (top !== lastTop) surface.style.top = top + "px";
    lastLeft = left; lastTop = top;
    surface.dataset.placement = side === "center" ? "center" : side + "-" + align;
    updating = false;
  }
  function update() { if (!disposed && !frame) frame = requestAnimationFrame(updateNow); }
  window.addEventListener("resize", update, { passive: true });
  window.visualViewport?.addEventListener("resize", update, { passive: true });
  window.visualViewport?.addEventListener("scroll", update, { passive: true });
  var resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(function(){ if (!updating) update(); }) : null;
  if (!virtual || contextElement) resizeObserver?.observe(observedTrigger);
  resizeObserver?.observe(surface);
  var mutationObserver = typeof MutationObserver === "function" ? new MutationObserver(update) : null;
  mutationObserver?.observe(surface, { childList: true, subtree: true, characterData: true });
  updateNow();
  return { update: update, dispose: function() {
    disposed = true; if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("scroll", update);
    resizeObserver?.disconnect(); mutationObserver?.disconnect();
  } };
}

/**
 * @param {{ surface: Element, anchor: Element | { getBoundingClientRect: () => DOMRect, contextElement?: Element }, placement?: string, trigger?: Element, restoreFocus?: boolean, closeOnOutsidePointer?: boolean, preventOutsidePointerDefault?: boolean, ignoreOutsidePointer?: (event: PointerEvent) => boolean, onClose?: (reason: string) => void }} options
 */
export function openAnchoredSurface(options) {
  var surface = options.surface;
  var anchor = options.anchor;
  setSurfaceOrigin(surface, anchor.getBoundingClientRect());
  var position = anchorSurface(anchor, surface, { placement: options.placement });
  var unregister = registerLayer({
    element: surface,
    trigger: options.trigger,
    restoreFocus: options.restoreFocus,
    closeOnOutsidePointer: options.closeOnOutsidePointer,
    preventOutsidePointerDefault: options.preventOutsidePointerDefault,
    ignoreOutsidePointer: options.ignoreOutsidePointer,
    onClose: options.onClose
  });
  return {
    update: position.update,
    dispose: function(){
      position.dispose();
      unregister({ restoreFocus: false });
      surface.classList.remove("visible");
    }
  };
}
