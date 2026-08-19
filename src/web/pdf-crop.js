import {
  PDF_AGENT_CROP_MAX_LONG_EDGE,
  expandPdfBounds,
  normalizedRectToPdfBounds,
  pdfAnchorBounds,
  viewportBounds
} from "../core/pdf-shared.js";
import { acquirePdfDocument } from "../ui/pdf-runtime.js";

export async function cropPdfSourceToDataUrl(blob, options) {
  return blobToDataUrl(await cropPdfSourceToBlob(blob, options));
}

export async function cropPdfSourceToBlob(blob, { sourceKey, pageNumber, anchor = null, normalizedRect = null, padding = 12, maxLongEdge = PDF_AGENT_CROP_MAX_LONG_EDGE } = {}) {
  if (!blob) throw new Error("PDF source is missing.");
  const lease = await acquirePdfDocument({ key: `crop:${sourceKey || `${blob.size}:${blob.type}`}`, blob });
  let page = null;
  try {
    page = await lease.document.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1, rotation: page.rotate });
    let bounds = anchor ? pdfAnchorBounds(anchor, pageNumber) : null;
    if (!bounds && normalizedRect) bounds = normalizedRectToPdfBounds(baseViewport, normalizedRect);
    bounds = expandPdfBounds(bounds, page.view, padding);
    if (!bounds) throw new Error("PDF crop is outside the visible page box.");
    const baseCrop = viewportBounds(baseViewport, bounds);
    const longEdge = Math.max(baseCrop[2] - baseCrop[0], baseCrop[3] - baseCrop[1]);
    const scale = Math.max(1, Math.min((300 / 72) * (Number(page.userUnit) || 1), maxLongEdge / Math.max(1, longEdge)));
    const viewport = page.getViewport({ scale, rotation: page.rotate });
    const crop = viewportBounds(viewport, bounds);
    const width = Math.max(1, Math.ceil(crop[2] - crop[0])), height = Math.max(1, Math.ceil(crop[3] - crop[1]));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white"; context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -crop[0], -crop[1]] }).promise;
    const result = await canvasToBlob(canvas);
    releaseCanvas(canvas);
    return result;
  } finally {
    page?.cleanup?.(); lease.release();
  }
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
}

function releaseCanvas(canvas) {
  try { canvas.width = 0; canvas.height = 0; } catch {}
}

async function canvasToBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Canvas could not be encoded as PNG.")), "image/png"));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
