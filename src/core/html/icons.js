/**
 * Canonical Rabbithole icon repository.
 *
 * Keep product-owned SVG geometry here. Consumers choose an icon by name and
 * may only override its rendered size; the viewBox and drawing attributes stay
 * consistent everywhere. The returned markup is trusted, static application
 * chrome and is safe to inline in live pages and self-contained snapshots.
 */

import { IONICONS_5 } from "./ionicons5.generated.js";
import { ICON_SELECTIONS } from "./icon-selection.js";

const BUNNY_SHAPES = `
  <ellipse cx="30" cy="17" rx="4.6" ry="12.5" transform="rotate(20 30 17)"></ellipse>
  <ellipse cx="21.5" cy="15.5" rx="4.6" ry="13" transform="rotate(3 21.5 15.5)"></ellipse>
  <circle cx="21" cy="33" r="9.5"></circle>
  <ellipse cx="36" cy="45" rx="17" ry="13.5"></ellipse>
  <circle cx="52.5" cy="49" r="5"></circle>`;

/** @param {keyof typeof IONICONS_5} name @param {number} size */
function ionicon(name, size) {
  const definition = IONICONS_5[name];
  if (!definition) throw new Error(`Unknown curated Ionicon: ${name}`);
  return { size, attrs: definition.attrs, body: definition.body };
}

/* The sidebar toggle is a panel-with-divider, not a hamburger: "menu" promises
   a menu, and its wide-short silhouette can never sit optically level with the
   round compose glyph beside it. Product-owned, drawn on the Ionicons
   512-grid/48-stroke system so it reads as part of the set. */
const RAIL_PANEL = {
  attrs: 'viewBox="0 0 512 512" fill="currentColor" stroke="currentColor"',
  body: '<rect x="64" y="64" width="384" height="384" rx="57" fill="none" stroke-linejoin="round" stroke-width="48"/>' +
    '<path fill="none" stroke-linecap="round" stroke-width="48" d="M192 64v384"/>',
};

/* The three folds a card offers, drawn as one mini-tree — a parent over two
   children — where a filled node is a folded node. The scope is the fill, so
   the three rows are told apart at a glance and never by their labels alone.
   Product-owned, drawn on the Ionicons 512-grid/48-stroke system so they read
   as part of the set. */
const FOLD_EDGES = '<path fill="none" stroke-linecap="round" stroke-width="48" d="M208.5 205.8L163.5 306.2M303.5 205.8l45 100.4"/>';

/** @param {number} cx @param {number} cy @param {boolean} folded */
function foldNode(cx, cy, folded) {
  return folded
    ? `<circle cx="${cx}" cy="${cy}" r="84"/>`
    : `<circle cx="${cx}" cy="${cy}" r="60" fill="none" stroke-width="48"/>`;
}

/** @param {boolean} parentFolded @param {boolean} childrenFolded */
function foldTree(parentFolded, childrenFolded) {
  return {
    attrs: 'viewBox="0 0 512 512" fill="currentColor" stroke="currentColor"',
    body: FOLD_EDGES + foldNode(256, 100, parentFolded) + foldNode(116, 412, childrenFolded) + foldNode(396, 412, childrenFolded),
  };
}

const ICON_DEFINITIONS = Object.freeze({
  bunny: { size: null, attrs: 'viewBox="0 0 64 64" fill="currentColor"', body: BUNNY_SHAPES },
  rail: { size: 16, ...RAIL_PANEL },
  new: ionicon(ICON_SELECTIONS.new, 16),
  canvas: ionicon(ICON_SELECTIONS.canvas, 16),
  "zoom-out": ionicon(ICON_SELECTIONS["zoom-out"], 16),
  "zoom-in": ionicon(ICON_SELECTIONS["zoom-in"], 16),
  frame: ionicon(ICON_SELECTIONS.frame, 16),
  tidy: ionicon(ICON_SELECTIONS.tidy, 16),
  /* square.and.arrow.up — the macOS share glyph. Deliberately not an arrow
     alone: bare diagonal arrows belong to the expand/contract window-zoom
     pair and the two families must never be confusable. */
  share: ionicon(ICON_SELECTIONS.share, 16),
  theme: ionicon(ICON_SELECTIONS.theme, 16),
  settings: ionicon(ICON_SELECTIONS.settings, 16),
  send: ionicon(ICON_SELECTIONS.send, 14),
  search: ionicon(ICON_SELECTIONS.search, 14),
  close: ionicon(ICON_SELECTIONS.close, 16),
  more: ionicon(ICON_SELECTIONS.more, 16),
  expand: ionicon(ICON_SELECTIONS.expand, 16),
  contract: ionicon(ICON_SELECTIONS.contract, 16),
  collapse: ionicon(ICON_SELECTIONS.collapse, 16),
  restore: ionicon(ICON_SELECTIONS.restore, 16),
  "fold-self": { size: 16, ...foldTree(true, false) },
  "fold-branch": { size: 16, ...foldTree(true, true) },
  "fold-children": { size: 16, ...foldTree(false, true) },
  "area-select": ionicon(ICON_SELECTIONS["area-select"], 16),
  "file-text": ionicon(ICON_SELECTIONS["file-text"], 16),
  question: ionicon(ICON_SELECTIONS.question, 18),
  file: ionicon(ICON_SELECTIONS.file, 18),
  paste: ionicon(ICON_SELECTIONS.paste, 18),
  link: ionicon(ICON_SELECTIONS.link, 18),
  plus: ionicon(ICON_SELECTIONS.plus, 14),
  delete: ionicon(ICON_SELECTIONS.delete, 16),
  eye: ionicon(ICON_SELECTIONS.eye, 14),
  "eye-off": ionicon(ICON_SELECTIONS["eye-off"], 14),
  chevron: ionicon(ICON_SELECTIONS.chevron, 12),
  copy: ionicon(ICON_SELECTIONS.copy, 16),
  /* The Share menu's three non-copy rows. "trail" keeps the ⤷ it replaces —
     the descent from the root down to this document — while "download" (a tray
     the arrow drops into) and "package" (one closed bundle) stay unmistakable
     from each other, which two boxes-with-a-down-arrow never would be. */
  trail: ionicon(ICON_SELECTIONS.trail, 16),
  download: ionicon(ICON_SELECTIONS.download, 16),
  package: ionicon(ICON_SELECTIONS.package, 16),
  rename: ionicon(ICON_SELECTIONS.rename, 16),
  check: ionicon(ICON_SELECTIONS.check, 16),
  info: ionicon(ICON_SELECTIONS.info, 13),
});

/** @param {keyof typeof ICON_DEFINITIONS} name @param {{ size?: number }=} options */
export function iconSvg(name, options = {}) {
  const definition = ICON_DEFINITIONS[name];
  if (!definition) throw new Error(`Unknown Rabbithole icon: ${name}`);
  const size = options.size ?? definition.size;
  if (size !== null && (!Number.isFinite(size) || size <= 0)) throw new Error("Icon size must be a positive number");
  const dimensions = size === null ? "" : ` width="${size}" height="${size}"`;
  return `<svg${dimensions} ${definition.attrs} focusable="false" aria-hidden="true">${definition.body}</svg>`;
}

export const BUNNY_MARK_SVG = iconSvg("bunny");

export function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1a1918"/><g fill="#efece5">${BUNNY_SHAPES}</g></svg>`;
}
