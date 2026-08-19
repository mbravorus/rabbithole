import { activateFocusTrap } from "../focus-trap.js";
import { anchorSurface } from "../overlay/anchor.js";
import { registerLayer } from "../overlay/layer-stack.js";

export function openPopover(options) {
  var trigger = options.trigger, surface = options.surface, closed = false;
  trigger?.setAttribute("aria-expanded", "true");
  var position = anchorSurface(trigger, surface, { placement: options.placement });
  // A surface with internal states (a note that reads and edits) answers
  // Escape itself, one level at a time; without onEscape the layer stack's
  // blanket dismissal is the right default.
  var trap = activateFocusTrap(options.trapRoot || surface, {
    initialFocus: options.initialFocus,
    restoreFocus: false,
    onEscape: options.onEscape
  });
  var unregister = registerLayer({
    element: surface,
    trigger: trigger,
    onClose: function(reason) { options.onClose?.(reason); },
    closeOnEscape: options.closeOnEscape,
    closeOnOutsidePointer: options.closeOnOutsidePointer,
    restoreFocus: options.restoreFocus
  });

  function close(settings) {
    if (closed) return;
    closed = true;
    trigger?.setAttribute("aria-expanded", "false");
    trap();
    position.dispose();
    unregister(settings);
  }

  return { close: close, dispose: close, update: position.update };
}
