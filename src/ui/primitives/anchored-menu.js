import { setSurfaceOrigin } from "../core.js";
import { openPopover } from "./popover.js";

export function createAnchoredMenu(options) {
  var surface = options.surface, popover = null, trigger = null, opened = false;

  function visibleItems(){
    return Array.prototype.slice.call(surface.querySelectorAll('[role="menuitem"]')).filter(function(item){
      return !item.hidden && item.style.display !== "none";
    });
  }
  function focusItem(item){
    visibleItems().forEach(function(candidate){ candidate.tabIndex = candidate === item ? 0 : -1; });
    if (item) item.focus();
  }
  function onKeydown(e){
    var items = visibleItems();
    if (!items.length) return;
    var index = items.indexOf(document.activeElement), target = null;
    if (e.key === "ArrowDown") target = items[(index + 1 + items.length) % items.length];
    else if (e.key === "ArrowUp") target = items[(index - 1 + items.length) % items.length];
    else if (e.key === "Home") target = items[0];
    else if (e.key === "End") target = items[items.length - 1];
    else if (e.key === "Enter" || e.key === " ") {
      if (index < 0) return;
      e.preventDefault();
      items[index].click();
      return;
    } else if (e.key === "Tab") {
      close();
      return;
    } else return;
    e.preventDefault();
    focusItem(target);
  }
  function open(nextTrigger, settings){
    settings = settings || {};
    if (opened) close({ restoreFocus: false });
    var items = visibleItems();
    items.forEach(function(item, index){ item.tabIndex = index === 0 ? 0 : -1; });
    trigger = nextTrigger;
    opened = true;
    surface.classList.add("visible");
    setSurfaceOrigin(surface, trigger.getBoundingClientRect());
    popover = openPopover({ trigger: trigger, surface: surface, placement: options.placement || "bottom-end",
      initialFocus: settings.focusFirst ? items[0] : null,
      onClose: close
    });
  }
  function close(settings){
    if (!opened && !popover) return;
    opened = false;
    surface.classList.remove("visible");
    var activePopover = popover;
    popover = null;
    if (activePopover) activePopover.close(settings);
    trigger = null;
    if (options.onClose) options.onClose();
  }
  function toggle(nextTrigger, settings){
    if (opened && trigger === nextTrigger){ close(); return false; }
    open(nextTrigger, settings);
    return true;
  }
  function dispose(){
    surface.removeEventListener("keydown", onKeydown);
    close({ restoreFocus: false });
  }

  surface.addEventListener("keydown", onKeydown);
  return { open: open, close: close, toggle: toggle, dispose: dispose,
    visibleItems: visibleItems, focusItem: focusItem,
    isOpen: function(){ return opened; } };
}
