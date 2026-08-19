/**
 * Dev-only source freshness for the served canvas page.
 *
 * Production reads every asset once and never stats a file again. With
 * `RABBITHOLE_DEV` set, the page is rebuilt from whatever is on disk at request
 * time, so the UI loop is: edit source, `node build.mjs --outdir=dist`, reload
 * the tab. No watcher, no auto-rebuild, no server restart.
 *
 * Both helpers keep the last good value: `build.mjs` clears `dist/` before it
 * rewrites it, so a reload landing mid-rebuild must serve stale bytes rather
 * than fail the render.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANVAS_STYLES } from "../../core/html/styles.js";
import { CANVAS_SHELL } from "../../core/html/shell.js";

const CORE_DIR = fileURLToPath(new URL("../../core/", import.meta.url));
// Staged copies live under node_modules so bare specifiers (marked, katex,
// highlight.js) still resolve through the normal upward lookup.
const STAGE_DIR = fileURLToPath(new URL("../../../node_modules/.rabbithole-dev/", import.meta.url));
const STATIC_CORE_HTML = Object.freeze({ CANVAS_STYLES, CANVAS_SHELL });

export function devEnabled() {
  return !!process.env.RABBITHOLE_DEV;
}

/**
 * Reader for one built file. Production memoizes the first read; dev re-reads
 * when the file's mtime moves and otherwise returns the cached text.
 */
export function createSourceReader(target) {
  const filePath = target instanceof URL ? fileURLToPath(target) : target;
  let cached = null;

  if (!devEnabled()) {
    return function readFile() {
      if (cached !== null) return cached;
      cached = fs.readFileSync(filePath, "utf8");
      return cached;
    };
  }

  let stamp = null;
  return function readFileLive() {
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      if (cached === null || mtime !== stamp) {
        cached = fs.readFileSync(filePath, "utf8");
        stamp = mtime;
      }
    } catch (error) {
      if (cached === null) throw error;
    }
    return cached;
  };
}

/**
 * Loader for a self-contained module tree. Re-importing an entry under a
 * cache-busting query would leave its dependencies on the old cached copies, so
 * the whole tree is staged into a fresh directory instead: every relative
 * import inside the copy resolves to the copy, which busts the entire graph.
 *
 * The ESM module cache is never released, so each reload retains one more graph
 * for the life of the process. That is acceptable for a dev loop.
 *
 * @param {{ dir: string, workDir: string, entries: Record<string, string> }} options
 */
export function createModuleTreeLoader({ dir, workDir, entries }) {
  let stamp = null;
  let loaded = null;

  return async function loadModuleTree() {
    try {
      const next = treeStamp(dir);
      if (loaded && next === stamp) return loaded;
      const target = path.join(workDir, next);
      if (!fs.existsSync(target)) fs.cpSync(dir, target, { recursive: true });
      const namespaces = {};
      for (const [name, relative] of Object.entries(entries)) {
        namespaces[name] = await import(pathToFileURL(path.join(target, relative)).href);
      }
      // Superseded stages are already parsed into the module cache; the files
      // are only litter from here.
      for (const entry of fs.readdirSync(workDir)) {
        if (entry !== next) fs.rmSync(path.join(workDir, entry), { recursive: true, force: true });
      }
      stamp = next;
      loaded = namespaces;
    } catch (error) {
      if (!loaded) throw error;
    }
    return loaded;
  };
}

/** Shell and stylesheet template modules, re-read from source under dev. */
const loadCoreHtml = createModuleTreeLoader({
  dir: CORE_DIR,
  workDir: STAGE_DIR,
  entries: { styles: "html/styles.js", shell: "html/shell.js" },
});

export async function getCoreHtml() {
  if (!devEnabled()) return STATIC_CORE_HTML;
  try {
    const { styles, shell } = await loadCoreHtml();
    return { CANVAS_STYLES: styles.CANVAS_STYLES, CANVAS_SHELL: shell.CANVAS_SHELL };
  } catch {
    return STATIC_CORE_HTML;
  }
}

/** Directory identity: file count plus newest mtime, so edits and deletions both register. */
function treeStamp(dir) {
  let count = 0;
  let newest = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      count += 1;
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs > newest) newest = mtimeMs;
    }
  };
  walk(dir);
  return `${count}-${Math.round(newest)}`;
}
