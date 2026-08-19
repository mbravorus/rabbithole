/*
 * The settings sheet — one surface for every global preference.
 *
 * The gear holds global preferences. The card ⋯ menu holds per-card settings.
 * ⌘K holds navigation and actions. Everything here follows from that rule.
 *
 * The skeleton and the Appearance section are shared: they ship in the MCP
 * page, in the web app, and in frozen snapshots (appearance is a way of
 * looking, and looking survives into a snapshot). Hosts compose the rest —
 * the web app registers Model — so sections are data and the surface is one.
 */

import { escapeHtml } from "../core/utils.js";
import { iconSvg } from "../core/html/icons.js";
import { openDialog } from "./primitives/dialog.js";
import {
  READING_SCALE_MAX,
  READING_SCALE_MIN,
  READING_SCALE_STEP,
  applyTheme,
  clampReadingScale,
  onPreferenceChange,
  readingScale,
  setReadingScale,
  setThemePreference,
  themePreference,
} from "./preferences.js";

var SCRIM_ID = "settings-sheet-scrim";
var SHEET_ID = "settings-sheet";
var THEME_CHOICES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

var sections = [];
var hostLabel = "Local";
var boundTrigger = null;
var boundHandler = null;
var scrim = null;
var dialog = null;
var activeTrigger = null;
var mountedSection = null;
var mountedDispose = null;

/**
 * @typedef {{ id: string, label: string, order?: number,
 *   mount: (host: Element) => (void | (() => void)) }} SettingsSection
 */

/** @param {SettingsSection} section */
export function registerSettingsSection(section){
  if (!section || !section.id) return;
  unregisterSettingsSection(section.id);
  sections.push({ id: section.id, label: section.label || section.id, order: Number(section.order) || 0, mount: section.mount });
  sections.sort(function(a, b){ return a.order - b.order; });
}

function unregisterSettingsSection(id){
  var index = sections.findIndex(function(entry){ return entry.id === id; });
  if (index !== -1) sections.splice(index, 1);
}

function appearanceSection(){
  return { id: "appearance", label: "Appearance", order: 0, mount: mountAppearance };
}

/*
 * Idempotent by design: the gear lives in the shared taskbar, which outlives
 * any one hole. The web app boots the sheet before a hole exists (the blank
 * canvas has a gear too); the UI composition calls this again on every hole
 * and simply re-confirms the same binding.
 */
export function initSettingsSheet(options){
  options = options || {};
  if (options.hostLabel) hostLabel = options.hostLabel;
  if (!sections.some(function(entry){ return entry.id === "appearance"; })) registerSettingsSection(appearanceSection());
  var gear = document.getElementById("t-settings");
  if (!gear || gear === boundTrigger) return;
  unbindTrigger();
  boundHandler = function(){
    if (isSettingsSheetOpen()) closeSettingsSheet();
    else openSettingsSheet({ trigger: gear });
  };
  gear.addEventListener("click", boundHandler);
  gear.setAttribute("aria-haspopup", "dialog");
  gear.setAttribute("aria-expanded", "false");
  boundTrigger = gear;
}

function unbindTrigger(){
  if (boundTrigger && boundHandler) boundTrigger.removeEventListener("click", boundHandler);
  boundTrigger = null;
  boundHandler = null;
}

export function isSettingsSheetOpen(){
  return !!scrim;
}

function sheetMarkup(){
  var nav = sections.map(function(entry, index){
    return '<button type="button" class="settings-nav-item" role="tab" id="settings-nav-' + escapeHtml(entry.id) + '"' +
      ' data-settings-section="' + escapeHtml(entry.id) + '" aria-controls="settings-pane-body"' +
      ' aria-selected="false" tabindex="' + (index === 0 ? "0" : "-1") + '">' + escapeHtml(entry.label) + "</button>";
  }).join("");
  return '<section id="' + SHEET_ID + '" class="settings-sheet" tabindex="-1" aria-labelledby="settings-sheet-title">' +
    '<div class="settings-sheet-side">' +
      '<h2 id="settings-sheet-title" class="settings-sheet-title">Settings</h2>' +
      '<div class="settings-nav" role="tablist" aria-orientation="vertical" aria-labelledby="settings-sheet-title">' + nav + "</div>" +
      '<div class="settings-sheet-identity"><span>Rabbithole</span><span data-settings-host>' + escapeHtml(hostLabel) + "</span></div>" +
    "</div>" +
    '<div class="settings-sheet-pane">' +
      '<header class="settings-pane-head">' +
        '<h3 class="settings-pane-title" id="settings-pane-title"></h3>' +
        '<button type="button" class="settings-sheet-close" data-settings-close aria-label="Close settings">' + iconSvg("close") + "</button>" +
      "</header>" +
      '<div class="settings-pane-body" id="settings-pane-body" role="tabpanel" tabindex="0"></div>' +
    "</div>" +
  "</section>";
}

export function openSettingsSheet(options){
  options = options || {};
  var wantedSection = options.section && sections.some(function(entry){ return entry.id === options.section; })
    ? options.section
    : (sections[0] && sections[0].id) || "";
  if (scrim){
    if (options.trigger) activeTrigger = options.trigger;
    if (wantedSection) showSection(wantedSection, { focus: false });
    if (typeof options.initialFocus === "function") focusRequested(options.initialFocus);
    return;
  }
  if (!sections.length) return;
  activeTrigger = options.trigger || document.getElementById("t-settings") || null;
  scrim = document.createElement("div");
  scrim.id = SCRIM_ID;
  scrim.className = "settings-sheet-scrim";
  scrim.hidden = true;
  scrim.innerHTML = sheetMarkup();
  document.body.append(scrim);

  var sheet = scrim.querySelector("#" + SHEET_ID);
  scrim.querySelector("[data-settings-close]").addEventListener("click", function(){ closeSettingsSheet(); });
  scrim.querySelectorAll("[data-settings-section]").forEach(function(button){
    button.addEventListener("click", function(){ showSection(button.dataset.settingsSection, { focus: true }); });
  });
  scrim.querySelector(".settings-nav").addEventListener("keydown", onNavKeydown);

  showSection(wantedSection, { focus: false });

  if (activeTrigger){
    activeTrigger.setAttribute("aria-expanded", "true");
    activeTrigger.setAttribute("aria-controls", SHEET_ID);
  }
  dialog = openDialog({
    backdrop: scrim,
    dialog: sheet,
    labelledby: "settings-sheet-title",
    trigger: activeTrigger,
    // The ELEMENT, never a selector — a selector that misses silently drops
    // focus onto the body and the trap has nothing to hold.
    initialFocus: typeof options.initialFocus === "function" ? options.initialFocus(scrim) || sheet : sheet,
    closeOnBackdrop: true,
    onClose: finishClose,
  });
}

function focusRequested(resolve){
  var target = resolve(scrim);
  if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
}

export function closeSettingsSheet(settings){
  if (!dialog) return;
  dialog.close("programmatic", settings);
}

/*
 * Exits are softer and faster than enters. openDialog hides the backdrop the
 * moment it closes, so the sheet is un-hidden for exactly the length of its
 * exit animation with pointer events off, then removed.
 */
function finishClose(){
  var closing = scrim;
  scrim = null;
  dialog = null;
  unmountSection();
  if (activeTrigger){
    activeTrigger.setAttribute("aria-expanded", "false");
    activeTrigger.removeAttribute("aria-controls");
  }
  activeTrigger = null;
  if (!closing) return;
  // A sheet on its way out is addressable by nobody: strip its ids so a sheet
  // opened during the exit animation is never shadowed by its predecessor.
  closing.querySelectorAll("[id]").forEach(function(element){ element.removeAttribute("id"); });
  closing.removeAttribute("id");
  closing.hidden = false;
  closing.classList.add("closing");
  var remove = function(){ closing.remove(); };
  var duration = motionDuration("--duration-fast");
  if (duration <= 0) remove();
  else setTimeout(remove, duration + 20);
}

function motionDuration(token){
  try {
    var raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (raw.endsWith("ms")) return parseFloat(raw) || 0;
    if (raw.endsWith("s")) return (parseFloat(raw) || 0) * 1000;
  } catch (error) {}
  return 120;
}

function unmountSection(){
  var dispose = mountedDispose;
  mountedDispose = null;
  mountedSection = null;
  if (typeof dispose === "function"){
    try { dispose(); } catch (error) {}
  }
}

function showSection(id, options){
  if (!scrim) return;
  var entry = sections.find(function(candidate){ return candidate.id === id; }) || sections[0];
  if (!entry) return;
  if (mountedSection === entry.id) return;
  unmountSection();
  mountedSection = entry.id;
  scrim.querySelector("#settings-pane-title").textContent = entry.label;
  var body = scrim.querySelector("#settings-pane-body");
  body.replaceChildren();
  body.scrollTop = 0;
  body.setAttribute("aria-labelledby", "settings-nav-" + entry.id);
  scrim.querySelectorAll("[data-settings-section]").forEach(function(button){
    var selected = button.dataset.settingsSection === entry.id;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
    if (selected && options && options.focus) button.focus({ preventScroll: true });
  });
  mountedDispose = entry.mount(body) || null;
}

function onNavKeydown(event){
  if (["ArrowDown", "ArrowUp", "Home", "End"].indexOf(event.key) === -1) return;
  var buttons = Array.prototype.slice.call(event.currentTarget.querySelectorAll("[data-settings-section]"));
  if (buttons.length < 2) return;
  event.preventDefault();
  var current = Math.max(0, buttons.indexOf(document.activeElement));
  var next = event.key === "Home" ? 0
    : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? (current + 1) % buttons.length
        : (current - 1 + buttons.length) % buttons.length;
  showSection(buttons[next].dataset.settingsSection, { focus: true });
}

// ----------------------------------------------------------- Appearance

function rowMarkup(id, label, sub, control){
  return '<div class="settings-sheet-row" id="' + id + '-row">' +
    '<div class="settings-sheet-copy"><span class="settings-sheet-label" id="' + id + '-label">' + escapeHtml(label) + "</span>" +
    (sub ? '<small class="settings-sheet-sub">' + escapeHtml(sub) + "</small>" : "") + "</div>" +
    '<div class="settings-sheet-control">' + control + "</div></div>";
}

function appearanceMarkup(){
  var segments = THEME_CHOICES.map(function(choice){
    return '<button type="button" class="settings-segment" role="radio" data-theme-choice="' + choice.value + '"' +
      ' aria-checked="false" tabindex="-1">' + escapeHtml(choice.label) + "</button>";
  }).join("");
  var theme = '<div class="settings-segmented" role="radiogroup" aria-labelledby="settings-theme-label">' + segments + "</div>";
  var size = '<div class="settings-stepper" role="group" aria-labelledby="settings-reading-size-label">' +
    '<button type="button" class="settings-step" data-reading-step="-1" aria-label="Decrease reading size">A−</button>' +
    '<span class="settings-step-value" data-reading-value aria-live="polite">100%</span>' +
    '<button type="button" class="settings-step" data-reading-step="1" aria-label="Increase reading size">A+</button>' +
    '<button type="button" class="settings-reset" data-reading-reset hidden>Reset</button>' +
    "</div>";
  // Subs describe the effect, never the mechanism — what changes, not how.
  return '<div class="settings-sheet-section">' +
    rowMarkup("settings-theme", "Theme", "What the canvas follows.", theme) +
    rowMarkup("settings-reading-size", "Reading size", "Scales every card; each can fine-tune.", size) +
    "</div>";
}

function mountAppearance(host){
  host.innerHTML = appearanceMarkup();
  var segments = Array.prototype.slice.call(host.querySelectorAll("[data-theme-choice]"));
  var value = host.querySelector("[data-reading-value]");
  var reset = host.querySelector("[data-reading-reset]");

  function syncTheme(){
    var preference = themePreference();
    segments.forEach(function(button){
      var selected = button.dataset.themeChoice === preference;
      button.setAttribute("aria-checked", selected ? "true" : "false");
      button.tabIndex = selected ? 0 : -1;
    });
  }

  function syncSize(){
    var percent = Math.round(readingScale() * 100);
    value.textContent = percent + "%";
    reset.hidden = percent === 100;
  }

  segments.forEach(function(button){
    button.addEventListener("click", function(){
      setThemePreference(button.dataset.themeChoice);
    });
  });
  host.querySelector(".settings-segmented").addEventListener("keydown", function(event){
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].indexOf(event.key) === -1) return;
    event.preventDefault();
    var current = Math.max(0, segments.indexOf(document.activeElement));
    var next = event.key === "Home" ? 0
      : event.key === "End" ? segments.length - 1
        : event.key === "ArrowRight" || event.key === "ArrowDown" ? (current + 1) % segments.length
          : (current - 1 + segments.length) % segments.length;
    setThemePreference(segments[next].dataset.themeChoice);
    segments[next].focus({ preventScroll: true });
  });

  host.querySelectorAll("[data-reading-step]").forEach(function(button){
    button.addEventListener("click", function(){
      setReadingScale(readingScale() + Number(button.dataset.readingStep) * READING_SCALE_STEP);
    });
  });
  reset.addEventListener("click", function(){
    setReadingScale(1);
    reset.hidden = true;
  });

  function syncStepBounds(){
    var scale = clampReadingScale(readingScale());
    host.querySelector('[data-reading-step="-1"]').disabled = scale <= READING_SCALE_MIN + 0.001;
    host.querySelector('[data-reading-step="1"]').disabled = scale >= READING_SCALE_MAX - 0.001;
  }

  var stopListening = onPreferenceChange(function(kind){
    if (kind === "theme") syncTheme();
    if (kind === "reading-scale"){ syncSize(); syncStepBounds(); }
  });

  applyTheme();
  syncTheme();
  syncSize();
  syncStepBounds();
  return stopListening;
}
