import { validateImageAssetName } from "../core/assets.js";
import { resolveAssetUrl } from "./renderer.js";

export function originAttachmentNames(node) {
  if (!Array.isArray(node?.origin?.attachment_assets)) return [];
  const names = [];
  for (const rawName of node.origin.attachment_assets) {
    try { names.push(validateImageAssetName(rawName)); } catch {}
    if (names.length === 4) break;
  }
  return names;
}

export function appendOriginAttachmentThumbnails(container, node) {
  const names = originAttachmentNames(node);
  if (!names.length) return null;
  const strip = document.createElement("div"); strip.className = "origin-attachment-strip";
  for (const name of names) {
    const image = document.createElement("img");
    image.src = resolveAssetUrl(name);
    image.alt = "Pasted image";
    image.loading = "eager";
    image.draggable = false;
    strip.appendChild(image);
  }
  container.appendChild(strip);
  return strip;
}
