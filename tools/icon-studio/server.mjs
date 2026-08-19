import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ICON_SELECTIONS } from "../../src/core/html/icon-selection.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const studioDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(studioDir, "../..");
const selectionFile = path.join(rootDir, "src/core/html/icon-selection.js");
const iconPackageRoot = path.dirname(require.resolve("@iconify-json/ion/package.json"));
const iconSet = JSON.parse(await fs.readFile(path.join(iconPackageRoot, "icons.json"), "utf8"));
const iconPackage = JSON.parse(await fs.readFile(path.join(iconPackageRoot, "package.json"), "utf8"));
const port = parsePort(process.env.RABBITHOLE_ICON_STUDIO_PORT || "4178");
const origin = `http://127.0.0.1:${port}`;
const roles = Object.freeze([
  role("rail", "Rabbitholes", "Navigation", "Open the saved Rabbitholes sidebar.", ["library", "books", "collection", "list", "albums", "menu"]),
  role("new", "New Rabbithole", "Navigation", "Start a new document or question.", ["create", "compose", "pencil", "add", "new", "document"]),
  role("canvas", "Canvas", "Navigation", "Return to the branching canvas.", ["git", "branch", "nodes", "network", "canvas", "map"]),
  role("zoom-out", "Zoom out", "Canvas", "Decrease the canvas zoom level.", ["remove", "minus", "zoom", "contract"]),
  role("zoom-in", "Zoom in", "Canvas", "Increase the canvas zoom level.", ["add", "plus", "zoom", "expand"]),
  role("frame", "Frame everything", "Canvas", "Fit the complete graph in view.", ["scan", "focus", "frame", "fit", "corners", "expand"]),
  role("tidy", "Tidy layout", "Canvas", "Automatically organize the node graph.", ["network", "git", "hierarchy", "organize", "grid", "nodes"]),
  role("share", "Share & export", "Canvas", "Open sharing and export actions.", ["share", "upload", "export", "arrow"]),
  role("theme", "Theme", "Canvas", "Switch between light and dark themes.", ["contrast", "moon", "sunny", "theme", "color"]),
  role("settings", "Settings", "Canvas", "Open model and provider settings.", ["settings", "cog", "options", "sliders"]),
  role("send", "Send", "Composition", "Submit a question or follow-up.", ["arrow-up", "send", "paper-plane", "enter"]),
  role("search", "Search", "Composition", "Find a model, item, or document.", ["search", "find", "magnify"]),
  role("close", "Close", "Composition", "Dismiss the current surface.", ["close", "x", "dismiss"]),
  role("expand", "Expand card", "Reading", "Open a card in the focused reader.", ["expand", "open", "maximize", "arrows"]),
  role("contract", "Back to canvas", "Reading", "Leave the focused reader.", ["contract", "minimize", "arrows", "return"]),
  role("collapse", "Collapse node", "Reading", "Collapse a node's document body.", ["remove", "minus", "collapse"]),
  role("restore", "Restore node", "Reading", "Restore a collapsed document body.", ["add", "plus", "restore"]),
  role("area-select", "Select PDF area", "PDF", "Draw a region over a PDF page.", ["crop", "scan", "select", "area", "focus"]),
  role("file-text", "Create text version", "PDF", "Convert a PDF into a text document.", ["document-text", "reader", "text", "document"]),
  role("question", "Ask a question", "Starting paths", "Begin with a question.", ["help", "question", "chat", "bulb"]),
  role("file", "Open document", "Starting paths", "Begin from a local document.", ["document", "file", "reader"]),
  role("paste", "Paste Markdown", "Starting paths", "Begin with pasted text or Markdown.", ["clipboard", "paste", "document", "text"]),
  role("link", "Open link", "Starting paths", "Begin from a web link.", ["link", "globe", "open", "attach"]),
  role("plus", "New action", "Actions", "Generic compact add action.", ["add", "plus", "new"]),
  role("delete", "Delete", "Actions", "Permanently remove an item.", ["trash", "delete", "remove", "bin"]),
  role("eye", "Show value", "Actions", "Reveal a hidden value.", ["eye", "show", "visible"]),
  role("eye-off", "Hide value", "Actions", "Conceal a visible value.", ["eye-off", "hide", "invisible"]),
  role("chevron", "Open menu", "Actions", "Expand a picker or menu.", ["chevron-down", "caret", "down", "menu"]),
  role("copy", "Copy", "Actions", "Copy content to the clipboard.", ["copy", "duplicate", "documents", "clipboard"]),
  role("check", "Success", "Actions", "Confirm a completed action.", ["checkmark", "done", "success"]),
  role("info", "Information", "Actions", "Show contextual information.", ["information", "info", "help-circle"]),
]);

let currentSelections = { ...ICON_SELECTIONS };
const roleNames = roles.map(({ name }) => name);
const iconNames = new Set(Object.keys(iconSet.icons));

if (iconPackage.iconSetVersion !== "5.5.4") {
  throw new Error(`Icon Studio requires Ionicons 5.5.4, found ${iconPackage.iconSetVersion}`);
}
if (roleNames.join("\0") !== Object.keys(currentSelections).join("\0")) {
  throw new Error("Icon Studio roles must exactly match ICON_SELECTIONS order");
}

const server = http.createServer(async (request, response) => {
  try {
    setSecurityHeaders(response);
    const url = new URL(request.url || "/", origin);
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      return json(response, 200, {
        iconSet: {
          name: "Ionicons",
          version: iconPackage.iconSetVersion,
          width: iconSet.width,
          height: iconSet.height,
          icons: iconSet.icons,
        },
        roles,
        selections: currentSelections,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/apply") {
      return await applySelections(request, response);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(response, 405, { error: "Method not allowed" });
    }
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(studioDir, requested);
    if (!file.startsWith(`${studioDir}${path.sep}`)) return json(response, 404, { error: "Not found" });
    const body = await fs.readFile(file);
    response.writeHead(200, {
      "Content-Type": contentType(file),
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") return response.end();
    response.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") return json(response, 404, { error: "Not found" });
    if (error?.status) return json(response, error.status, { error: error.message });
    process.stderr.write(`[icon-studio] ${error?.stack || error}\n`);
    json(response, 500, { error: "Icon Studio encountered an unexpected error." });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`Rabbithole Icon Studio running at ${origin}\n`);
});

async function applySelections(request, response) {
  if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
    return json(response, 403, { error: "This action is only available from the local Icon Studio." });
  }
  const body = await readJson(request, 100_000);
  const selections = body?.selections;
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
    return json(response, 400, { error: "Selections must be an object." });
  }
  if (Object.keys(selections).join("\0") !== roleNames.join("\0")) {
    return json(response, 400, { error: "Selections must include every product role in canonical order." });
  }
  for (const [name, icon] of Object.entries(selections)) {
    if (typeof icon !== "string" || !iconNames.has(icon)) {
      return json(response, 400, { error: `Unknown icon for ${name}: ${String(icon)}` });
    }
  }

  const unchanged = roleNames.every((name) => selections[name] === currentSelections[name]);
  if (unchanged) return json(response, 200, { changed: false, selections: currentSelections });

  const previousSource = await fs.readFile(selectionFile, "utf8");
  const nextSource = renderSelectionModule(selections);

  await atomicWrite(selectionFile, nextSource);
  try {
    await run(process.execPath, ["scripts/generate-ionicons.mjs"]);
    await run(process.execPath, ["build.mjs"]);
    currentSelections = { ...selections };
    return json(response, 200, { changed: true, selections: currentSelections });
  } catch (error) {
    await atomicWrite(selectionFile, previousSource);
    await run(process.execPath, ["scripts/generate-ionicons.mjs"]).catch(() => {});
    await run(process.execPath, ["build.mjs"]).catch(() => {});
    process.stderr.write(`[icon-studio] apply rolled back: ${error?.stderr || error}\n`);
    return json(response, 500, { error: "The selection could not be built, so the previous mapping was restored." });
  }
}

function role(name, label, group, description, keywords) {
  return Object.freeze({ name, label, group, description, keywords });
}

function renderSelectionModule(selections) {
  const entries = Object.entries(selections)
    .map(([name, icon]) => `  ${JSON.stringify(name)}: ${JSON.stringify(icon)},`)
    .join("\n");
  return `/**
 * The product-facing icon name -> Ionicons 5 source mapping.
 *
 * This small module is the editable source of truth shared by the application,
 * the generated icon payload, and the local Icon Studio. The bunny is a
 * Rabbithole brand mark rather than an interface icon and stays in icons.js.
 */
export const ICON_SELECTIONS = Object.freeze({
${entries}
});
`;
}

async function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, file);
}

async function run(command, args) {
  return execFileAsync(command, args, { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 });
}

async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error(`Invalid Icon Studio port: ${value}`);
  return parsed;
}
