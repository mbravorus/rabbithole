import { recordMeasuredAt, reportedContextUsage, unavailableContextUsage } from "./usage.js";

export function createCodexParser({ now } = {}) {
  let model = null;
  let latest = unavailableContextUsage("codex");

  return {
    pushLine(line) {
      let record;
      try { record = JSON.parse(line); } catch { return latest; }
      if (record?.type === "turn_context" && typeof record?.payload?.model === "string") {
        model = record.payload.model;
        if (latest.quality === "unavailable") latest = unavailableContextUsage("codex", model);
        return latest;
      }
      if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") return latest;

      const info = record.payload.info;
      const usedTokens = info?.last_token_usage?.total_tokens;
      const windowTokens = info?.model_context_window;
      latest = reportedContextUsage({
        agent: "codex",
        model,
        usedTokens,
        windowTokens,
        measuredAt: recordMeasuredAt(record, now),
      });
      return latest;
    },
    current() { return latest; },
  };
}

export function parseCodexTranscript(text, options) {
  const parser = createCodexParser(options);
  for (const line of String(text || "").split("\n")) if (line.trim()) parser.pushLine(line);
  return parser.current();
}
