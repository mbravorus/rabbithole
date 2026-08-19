import { openRabbithole, answerBranch, listRabbitholes } from "../rabbithole.js";
import { exportHoleToVault } from "../vault-export.js";
import { normalizeBaseUrl } from "../../core/base-url.js";
import { AUTHORING_VOCABULARY_V1 } from "../../core/prompts/authoring-v1.js";
import { MAX_ASSETS_PER_CALL } from "../../core/assets.js";
import { validateAssetEntriesSync } from "../fs-store.js";
import fs from "node:fs";

const PROGRESS_INTERVAL_MS = 4 * 60 * 1000;

function str(description, extra = {}) {
  return { kind: "string", description, ...extra };
}
function obj(fields, extra = {}) {
  return { kind: "object", fields, ...extra };
}
function arr(items, extra = {}) {
  return { kind: "array", items, ...extra };
}
function bool(description, extra = {}) {
  return { kind: "boolean", description, ...extra };
}

const assetInput = obj({
  name: str("Filename to use in markdown asset: references, e.g. diagram-1.png", { maxLength: 300 }),
  file_path: str("Local path to the image file to copy into this Rabbithole", { maxLength: 4096 }),
});

function validateOpen(params) {
  normalizeBaseUrl(params.base_url);
  validateAssetEntriesSync(params.assets);
  if (params.hole_id) return;
  if (!params.title && !looksLikePdf(params.file_path)) throw new Error("title is required when starting a new non-PDF Rabbithole");
  if (!params.content && !params.file_path) {
    throw new Error("Provide content or file_path when starting a new Rabbithole");
  }
}

function looksLikePdf(filePath) {
  if (/\.pdf$/i.test(String(filePath || ""))) return true;
  if (!filePath) return false;
  try {
    const fd = fs.openSync(filePath, "r");
    try { const bytes = Buffer.alloc(4); fs.readSync(fd, bytes, 0, 4, 0); return bytes.toString("ascii") === "%PDF"; }
    finally { fs.closeSync(fd); }
  } catch { return false; }
}

function validateAnswer(params) {
  normalizeBaseUrl(params.base_url);
  validateAssetEntriesSync(params.assets);
}

function progressIntervalMs() {
  const configured = Number(process.env.RABBITHOLE_PROGRESS_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : PROGRESS_INTERVAL_MS;
}

async function withProgressKeepalive(run, extra) {
  const progressToken = extra?._meta?.progressToken;
  if ((typeof progressToken !== "string" && typeof progressToken !== "number") || typeof extra?.sendNotification !== "function") return run();
  let progress = 0;
  const timer = setInterval(() => {
    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: ++progress, message: "Waiting for canvas activity." },
    }).catch(() => {});
  }, progressIntervalMs());
  timer.unref?.();
  try { return await run(); }
  finally { clearInterval(timer); }
}

export const toolDefinitions = [
  {
    name: "open_rabbithole",
    description:
      "Open a document on an infinite canvas so the human can read it and dive down rabbit holes. " +
      "Start a NEW hole with { title, content } (or { title, file_path }), or RESUME a saved one with " +
      "{ hole_id } (use list_rabbitholes to find it). " +
      "When opening content fetched from a URL or repo, pass the document's own URL as base_url so " +
      "relative images and links resolve. " +
      "For local images that are not on the web, pass assets and reference them as ![alt](asset:name.png). " +
      "For a local PDF, pass its path directly as file_path; Rabbithole extracts text and opens native JPEG pages automatically. " +
      "For arXiv, prefer the HTML version with base_url when available. " +
      "The canvas opens in the browser and this call BLOCKS until the human acts. " +
      "It returns status='branch_request' when the human selects text and asks a question — answer it " +
      "with answer_branch. A branch_request with EMPTY selected_text is a follow-up question about the " +
      "parent document as a whole (a chat reply beneath it) — answer conversationally in that document's " +
      "context. A branch_request may carry a 'lens' (explain | eli5 | example | deeper) — the question " +
      "text spells out the style the human tapped; honor it. One marked saved=true was asked while no " +
      "agent was listening — answer it like any other. When attachments are present, read every attachments[].image_path; these are images pasted into the question. When region.image_path is present, it is either " +
      "this selection's clip or the immediate parent's clip; read that image before answering and trust it over extracted text for math, tables, and figures. " +
      "A convert_request asks you to transcribe the listed page image_path files under its inline rules; stream the document through answer_branch with that request_id. " +
      "On a resumed hole the first branch_request carries " +
      "a 'rehydration' field with the whole tree (and any saved_asks); read it to reload your context. " +
      "Long waits remain blocked and should be left running in the background; never poll the canvas. " +
      "If the host truly cancels or times out the tool call, re-call open_rabbithole { hole_id } once; " +
      "nothing is lost and asks are saved. A status='already_listening' result means another live " +
      "background call owns delivery; do not call again. When the human explicitly asks to reopen or " +
      "show the canvas, resume with { hole_id, focus: true }. " +
      "It returns status='session_closed' with a reason when the human clicks Done or the session otherwise ends.",
    input: obj({
      title: str("Document title (required for a new hole)", { optional: true, maxLength: 2000 }),
      content: str("Raw markdown for the starting document", { optional: true, maxLength: 10485760 }),
      file_path: str("Path to a markdown or PDF file (PDF title is optional)", { optional: true, maxLength: 4096 }),
      base_url: str("Document URL used to resolve relative markdown links/images; absolute http(s) only", {
        optional: true,
        maxLength: 2000,
      }),
      assets: arr(assetInput, {
        optional: true,
        maxItems: MAX_ASSETS_PER_CALL,
        description:
          "Local image files to attach to this hole; reference them in markdown as asset:name.png images",
      }),
      hole_id: str("Resume a saved hole instead of starting a new one", { optional: true, maxLength: 200 }),
      focus: {
        kind: "boolean",
        description: "Bring an already-live canvas to the browser when the human explicitly asks to reopen or show it",
        optional: true,
      },
    }),
    validateInput: validateOpen,
    run: ({ title, content, file_path, base_url, hole_id, assets, focus }, extra) =>
      withProgressKeepalive(() => openRabbithole({
        title,
        content,
        filePath: file_path,
        baseUrl: base_url,
        holeId: hole_id,
        assets,
        focus,
        signal: extra?.signal,
      }), extra),
  },
  {
    name: "answer_branch",
    description: [
      "Answer one pending branch_request or convert_request from an open Rabbithole. For convert_request, read every pages[].image_path in order, follow rules exactly, stream transcription chunks, and emit figure: refs rather than cropping. For branch_request, write a focused answer using the supplied selection context; read every attachments[].image_path when attachments are present. When region.image_path is present, it may be the new selection clip or the immediate parent's clip, so read it and trust it over extracted text.",
      "",
      AUTHORING_VOCABULARY_V1,
      "",
      "Finish streaming by sending the remaining final chunk in a normal call with a short 'title'. Partial chunks concatenate verbatim: include your own spacing/newlines and never repeat text already sent. The final call becomes the one background listener and stays blocked until a real canvas event. Never poll or re-attach while it is running. If the host truly cancels or times out the call, resume once with open_rabbithole { hole_id }; do not re-send content because asks are saved.",
    ].join("\n"),
    input: obj({
      session_id: str("Active session ID from open_rabbithole", { maxLength: 200 }),
      request_id: str("The request_id of the branch_request being answered", { maxLength: 200 }),
      title: str("Short label for the new node (a few words; required on the final call)", { optional: true, maxLength: 2000 }),
      content: str("Markdown chunk (partial) or the remaining markdown (final call)", { maxLength: 10485760 }),
      base_url: str("Document URL used to resolve relative markdown links/images; absolute http(s) only", {
        optional: true,
        maxLength: 2000,
      }),
      assets: arr(assetInput, {
        optional: true,
        maxItems: MAX_ASSETS_PER_CALL,
        description:
          "Local image files to attach to this hole; reference them in markdown as asset:name.png images",
      }),
      partial: {
        kind: "boolean",
        description:
          "true = stream this chunk into the pending answer and return immediately; " +
          "omit/false = finish the answer and block for the next event",
        optional: true,
      },
    }),
    validateInput: validateAnswer,
    run: ({ session_id, request_id, title, content, base_url, assets, partial }, extra) =>
      withProgressKeepalive(() => answerBranch({
        sessionId: session_id,
        requestId: request_id,
        title,
        content,
        baseUrl: base_url,
        assets,
        partial,
        signal: extra?.signal,
      }), extra),
  },
  {
    name: "export_to_obsidian",
    description:
      "Export a saved Rabbithole into an Obsidian vault as a JSON Canvas plus one markdown note per " +
      "document, so the hole becomes searchable, crosslinkable vault knowledge. Each answer becomes a " +
      "note under <folder>/<slug>/notes/ with frontmatter provenance, questions become text cards, and " +
      "the canvas wires them together. Re-exporting the same hole SYNCS instead of clobbering: positions " +
      "and edits the human made in Obsidian win (edited notes are skipped and listed as conflicts). " +
      "vault_path is remembered as the default after the first call. Pass continuous=true to also export " +
      "automatically on every future save of any hole (continuous=false turns that off).",
    input: obj({
      hole_id: str("Hole to export (use list_rabbitholes to find it)"),
      vault_path: str("Absolute path to the Obsidian vault; optional after the first export", {
        optional: true,
      }),
      folder: str('Vault-relative folder to export into (default "Rabbitholes")', { optional: true }),
      roles: str(
        'Role annotations for AI-canvas plugins (invisible in native Obsidian): "context" (default; ' +
          'questions are user turns, documents stay plain), "turns" (documents stamped user/assistant ' +
          'too), or "none"',
        { optional: true }
      ),
      continuous: bool("Turn continuous vault sync on (true) or off (false) for future saves", {
        optional: true,
      }),
    }),
    resultKind: "json",
    run: ({ hole_id, vault_path, folder, roles, continuous }) =>
      exportHoleToVault({ holeId: hole_id, vaultPath: vault_path, folder, roles, continuous }),
  },
  {
    name: "list_rabbitholes",
    description:
      "List saved Rabbitholes (most recently updated first) so you can resume one by hole_id via " +
      "open_rabbithole. Returns id, title, last-updated time, and node count for each.",
    input: obj({}),
    run: () => listRabbitholes(),
  },
];
