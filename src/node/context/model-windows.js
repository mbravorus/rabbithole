// Keep this deliberately small and explicit. Claude transcripts do not carry
// a numeric context window, and model variants must never inherit a sibling's
// limit by prefix or family name.
export const CLAUDE_MODEL_WINDOWS_VERSION = "2026-08-12";
export const CLAUDE_MODEL_WINDOWS_SOURCE = "Anthropic context-window documentation";

export const CLAUDE_MODEL_WINDOWS = Object.freeze({
  "claude-fable-5": 1_000_000,
});

export function claudeModelWindow(model) {
  return typeof model === "string" && Object.hasOwn(CLAUDE_MODEL_WINDOWS, model)
    ? CLAUDE_MODEL_WINDOWS[model]
    : null;
}
