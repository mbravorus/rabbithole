import assert from "node:assert/strict";
import { extractNodeAssetRefs } from "../../src/core/assets.js";
import {
  CLIPBOARD_IMAGE_MAX_BYTES,
  CLIPBOARD_IMAGE_PNG_REENCODE_BYTES,
  clipboardImageOutput,
  clipboardImageSizeErrorCode,
  createPastedImageName,
  normalizedImageDimensions,
} from "../../src/ui/clipboard-image.js";

assert.deepEqual(normalizedImageDimensions(4000, 1000), { width: 2048, height: 512, downscaled: true });
assert.deepEqual(normalizedImageDimensions(800, 1200), { width: 800, height: 1200, downscaled: false });
assert.deepEqual(normalizedImageDimensions(1000, 4000), { width: 512, height: 2048, downscaled: true });
assert.deepEqual(clipboardImageOutput("image/jpeg"), { type: "image/jpeg", extension: "jpg", quality: 0.9 });
assert.deepEqual(clipboardImageOutput("image/svg+xml"), { type: "image/png", extension: "png", quality: undefined });
assert.deepEqual(clipboardImageOutput("image/png", CLIPBOARD_IMAGE_PNG_REENCODE_BYTES), { type: "image/png", extension: "png", quality: undefined });
assert.deepEqual(clipboardImageOutput("image/png", CLIPBOARD_IMAGE_PNG_REENCODE_BYTES + 1), { type: "image/jpeg", extension: "jpg", quality: 0.9 });
assert.equal(clipboardImageSizeErrorCode(CLIPBOARD_IMAGE_MAX_BYTES), null);
assert.equal(clipboardImageSizeErrorCode(CLIPBOARD_IMAGE_MAX_BYTES + 1), "clipboard_image_too_large");
assert.equal(clipboardImageSizeErrorCode(20 * 1024 * 1024 + 1), "asset_too_large");
assert.equal(createPastedImageName("image/jpeg", () => "1234-abcd"), "paste-1234-abcd.jpg");
assert.equal(createPastedImageName("image/tiff", () => "1234-abcd"), "paste-1234-abcd.png");

assert.deepEqual([...extractNodeAssetRefs({
  markdown: "![body](asset:body.png)",
  origin: { attachment_assets: ["paste-one.png", "paste-two.jpg", "../bad.png"] },
})], ["body.png", "paste-one.png", "paste-two.jpg"]);

console.log("ok clipboard images: naming, PNG-to-JPEG policy, per-image ceiling, downscale dimensions, and durable ask asset refs");
