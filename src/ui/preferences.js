/*
 * Preferences that belong to the reader, not the document.
 *
 * Theme and global reading size describe the eyes and the monitor in front of
 * the page — not the thing being read. They live in localStorage and never
 * enter the hole document, the node_update wire, exports, or the portable
 * format. Per-node `font_scale` is the authorial counterpart and stays in the
 * doc; the two compose (see fontPx in core.js).
 */

var THEME_KEY = "rh-theme";
var READING_SCALE_KEY = "rh-reading-scale";

export var READING_SCALE_MIN = 0.8;
export var READING_SCALE_MAX = 1.4;
export var READING_SCALE_STEP = 0.1;

var listeners = [];
var systemThemeMql = null;
var readingScaleCache = null;
var swapFrame = 0;

/*
 * A frozen snapshot is often opened from a file or a data document where
 * localStorage throws. The preference still has to hold for the life of the
 * page, so an unwritable store falls back to memory rather than silently
 * refusing the change.
 */
var memory = Object.create(null);

function readStored(key){
  // A value only lands in memory when the store refused it, so it is always
  // the more recent intent.
  if (memory[key] !== undefined) return memory[key];
  try { return localStorage.getItem(key) || ""; } catch (error) {}
  return "";
}

function writeStored(key, value){
  try {
    localStorage.setItem(key, value);
    delete memory[key];
  } catch (error) {
    memory[key] = value;
  }
}

export function onPreferenceChange(handler){
  if (typeof handler !== "function") return function(){};
  listeners.push(handler);
  return function(){
    var index = listeners.indexOf(handler);
    if (index !== -1) listeners.splice(index, 1);
  };
}

function notify(kind){
  var snapshot = listeners.slice();
  for (var i = 0; i < snapshot.length; i++){
    try { snapshot[i](kind); } catch (error) {}
  }
}

// ---------------------------------------------------------------- theme

/** The stored choice: "light", "dark", or "system" (the default). */
export function themePreference(){
  var saved = readStored(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function systemTheme(){
  try {
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch (error) {
    return "light";
  }
}

/** What the page actually paints right now. */
export function resolvedTheme(){
  var preference = themePreference();
  return preference === "system" ? systemTheme() : preference;
}

export function setThemePreference(value){
  var next = value === "light" || value === "dark" ? value : "system";
  writeStored(THEME_KEY, next);
  applyTheme();
  notify("theme");
  return next;
}

/*
 * The taskbar button is a quick toggle, not a third state: pressing it always
 * commits an explicit light/dark choice and leaves "system" behind.
 */
export function toggleTheme(){
  return setThemePreference(resolvedTheme() === "dark" ? "light" : "dark");
}

export function applyTheme(){
  var root = document.documentElement;
  var resolved = resolvedTheme();
  if (root.getAttribute("data-theme") !== resolved) suppressColorTransitions(root);
  root.setAttribute("data-theme", resolved);
  syncSystemThemeListener();
  return resolved;
}

/*
 * Every surface animates its colours; swapping the whole palette through those
 * transitions smears the page for a frame. Kill them for exactly the swap.
 */
function suppressColorTransitions(root){
  root.classList.add("theme-swapping");
  var clear = function(){
    swapFrame = 0;
    root.classList.remove("theme-swapping");
  };
  if (swapFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(swapFrame);
  if (typeof requestAnimationFrame !== "function"){ clear(); return; }
  swapFrame = requestAnimationFrame(function(){
    swapFrame = requestAnimationFrame(clear);
  });
}

function onSystemThemeChange(){
  if (themePreference() !== "system") return;
  applyTheme();
  notify("theme");
}

function syncSystemThemeListener(){
  var wanted = themePreference() === "system";
  if (wanted && !systemThemeMql){
    try { systemThemeMql = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null; } catch (error) { systemThemeMql = null; }
    if (!systemThemeMql) return;
    if (systemThemeMql.addEventListener) systemThemeMql.addEventListener("change", onSystemThemeChange);
    else if (systemThemeMql.addListener) systemThemeMql.addListener(onSystemThemeChange);
    return;
  }
  if (!wanted && systemThemeMql){
    if (systemThemeMql.removeEventListener) systemThemeMql.removeEventListener("change", onSystemThemeChange);
    else if (systemThemeMql.removeListener) systemThemeMql.removeListener(onSystemThemeChange);
    systemThemeMql = null;
  }
}

// -------------------------------------------------------- reading size

export function clampReadingScale(value){
  var numeric = typeof value === "number" ? value : parseFloat(value);
  if (!isFinite(numeric)) return 1;
  return Math.round(Math.min(READING_SCALE_MAX, Math.max(READING_SCALE_MIN, numeric)) * 100) / 100;
}

export function readingScale(){
  if (readingScaleCache === null) readingScaleCache = clampReadingScale(readStored(READING_SCALE_KEY));
  return readingScaleCache;
}

export function setReadingScale(value){
  var next = clampReadingScale(value);
  readingScaleCache = next;
  writeStored(READING_SCALE_KEY, String(next));
  notify("reading-scale");
  return next;
}

