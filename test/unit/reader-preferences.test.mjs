import assert from "node:assert/strict";

/*
 * Theme and global reading size belong to the reader, not the document. This
 * covers the pure part: clamping, the three-state theme, and the fact that a
 * store that refuses writes still holds the choice for the life of the page.
 */

const store = new Map();
let storageWritable = true;
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    if (!storageWritable) throw new Error("storage is unavailable");
    store.set(key, String(value));
  },
  removeItem: (key) => store.delete(key),
};

let systemPrefersDark = false;
const mediaListeners = new Set();
const root = {
  attributes: new Map(),
  classList: { add(){}, remove(){} },
  getAttribute(name){ return this.attributes.has(name) ? this.attributes.get(name) : null; },
  setAttribute(name, value){ this.attributes.set(name, value); },
};
globalThis.document = { documentElement: root };
globalThis.window = {
  matchMedia: (query) => ({
    matches: query.includes("dark") ? systemPrefersDark : false,
    addEventListener: (_type, handler) => mediaListeners.add(handler),
    removeEventListener: (_type, handler) => mediaListeners.delete(handler),
  }),
};
globalThis.matchMedia = globalThis.window.matchMedia;

const {
  READING_SCALE_MAX,
  READING_SCALE_MIN,
  applyTheme,
  clampReadingScale,
  onPreferenceChange,
  readingScale,
  resolvedTheme,
  setReadingScale,
  setThemePreference,
  themePreference,
  toggleTheme,
} = await import("../../src/ui/preferences.js");

// ---- reading size ---------------------------------------------------------

assert.equal(readingScale(), 1, "an unset reading size is 100%");
assert.equal(clampReadingScale(2.5), READING_SCALE_MAX, "reading size clamps at the top");
assert.equal(clampReadingScale(0.2), READING_SCALE_MIN, "reading size clamps at the bottom");
assert.equal(clampReadingScale("nonsense"), 1, "an unreadable stored value falls back to 100%");
assert.equal(clampReadingScale(1.0000000001), 1, "float drift never leaks into the displayed percentage");
assert.equal(clampReadingScale(1.15), 1.15, "a half step survives the round trip");

const seen = [];
const stopListening = onPreferenceChange((kind) => seen.push(kind));
assert.equal(setReadingScale(1.2), 1.2);
assert.equal(store.get("rh-reading-scale"), "1.2", "the global reading size lives in its own storage slot");
assert.equal(readingScale(), 1.2);
assert.equal(setReadingScale(9), READING_SCALE_MAX, "out-of-range input is clamped before it is stored");
setReadingScale(1);

// The composition the cards render: base x global x per-node font_scale.
const effective = (base, global, fontScale) => Math.round(base * global * fontScale);
assert.equal(effective(17, 1.2, 1.15), 23, "reader base 17 at global 120% and card 115%");
assert.equal(effective(14, 1.2, 1.15), 19, "canvas base 14 at global 120% and card 115%");
assert.equal(effective(14, 1, 1.15), 16, "the same card at global 100% is smaller — the two compose, neither replaces");

// ---- theme ----------------------------------------------------------------

assert.equal(themePreference(), "system", "no stored choice means the page follows the system");
systemPrefersDark = true;
assert.equal(resolvedTheme(), "dark");
applyTheme();
assert.equal(root.getAttribute("data-theme"), "dark", "system resolves to a painted theme");
assert.equal(mediaListeners.size, 1, "system mode listens for the system flipping under it");

systemPrefersDark = false;
mediaListeners.forEach((handler) => handler());
assert.equal(root.getAttribute("data-theme"), "light", "a system flip repaints while the preference stays system");
assert.equal(themePreference(), "system");

assert.equal(setThemePreference("dark"), "dark");
assert.equal(store.get("rh-theme"), "dark", "the theme keeps its existing storage slot");
assert.equal(root.getAttribute("data-theme"), "dark");
assert.equal(mediaListeners.size, 0, "an explicit choice stops following the system");

// The taskbar button is a quick toggle: it always commits an explicit choice.
setThemePreference("system");
systemPrefersDark = true;
applyTheme();
assert.equal(toggleTheme(), "light", "toggling out of system writes the opposite of what is painted");
assert.equal(themePreference(), "light");

assert.deepEqual(new Set(seen), new Set(["reading-scale", "theme"]), "both preferences announce their changes");
stopListening();
const before = seen.length;
setReadingScale(1.1);
assert.equal(seen.length, before, "unsubscribing stops the announcements");

// ---- a store that refuses writes ------------------------------------------

storageWritable = false;
assert.equal(setThemePreference("dark"), "dark");
assert.equal(themePreference(), "dark", "a snapshot opened without localStorage still holds the choice");
assert.equal(setReadingScale(1.3), 1.3);
assert.equal(readingScale(), 1.3);
storageWritable = true;

console.log("reader preferences ok");
