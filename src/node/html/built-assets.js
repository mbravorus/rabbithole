import fs from "node:fs";
import { CANVAS_STYLES } from "../../core/html/styles.js";
import { createSourceReader, devEnabled, getCoreHtml } from "./dev-reload.js";

const CLIENT_PATH = new URL("../../../dist/client.js", import.meta.url);
const FROZEN_CLIENT_PATH = new URL("../../../dist/frozen-client.js", import.meta.url);
const KATEX_CSS_PATH = new URL("../../../dist/katex.css", import.meta.url);
const DOMPURIFY_SCRIPT_PATH = new URL("../../../dist/dompurify.js", import.meta.url);
const MERMAID_SCRIPT_PATH = new URL("../../../dist/mermaid.js", import.meta.url);
const PDF_WORKER_PATH = new URL("../../../dist/pdf.worker.mjs", import.meta.url);
const PDFJS_PATH = new URL("../../../dist/pdf.mjs", import.meta.url);

// Shipped installs read the bundles once at import and freeze them. Under
// RABBITHOLE_DEV the frozen object is skipped and every access re-reads changed
// files, so a browser reload picks up a rebuild without restarting the server.
const UI_ASSETS = devEnabled() ? null : Object.freeze({
  stylesheetText: `${CANVAS_STYLES}\n${fs.readFileSync(KATEX_CSS_PATH, "utf8")}`,
  clientSource: fs.readFileSync(CLIENT_PATH, "utf8"),
  frozenClientSource: fs.readFileSync(FROZEN_CLIENT_PATH, "utf8"),
});

const readKatexCss = createSourceReader(KATEX_CSS_PATH);
const readClient = createSourceReader(CLIENT_PATH);
const readFrozenClient = createSourceReader(FROZEN_CLIENT_PATH);

export async function getUiAssets() {
  if (UI_ASSETS) return UI_ASSETS;
  const core = await getCoreHtml();
  return {
    stylesheetText: `${core.CANVAS_STYLES}\n${readKatexCss()}`,
    clientSource: readClient(),
    frozenClientSource: readFrozenClient(),
  };
}

export const getDompurifyScript = createSourceReader(DOMPURIFY_SCRIPT_PATH);
export const getMermaidScript = createSourceReader(MERMAID_SCRIPT_PATH);
export const getPdfWorkerScript = createSourceReader(PDF_WORKER_PATH);
export const getPdfJsScript = createSourceReader(PDFJS_PATH);
