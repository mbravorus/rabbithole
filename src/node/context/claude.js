import { claudeModelWindow } from "./model-windows.js";
import { recordMeasuredAt, reportedContextUsage, unavailableContextUsage } from "./usage.js";

export function createClaudeParser({ now } = {}) {
  let latest = unavailableContextUsage("claude");

  return {
    pushLine(line) {
      let record;
      try { record = JSON.parse(line); } catch { return latest; }
      const message = record?.message;
      if (!message || (record.type !== "assistant" && message.role !== "assistant") || !Object.hasOwn(message, "usage")) return latest;

      const model = typeof message.model === "string" ? message.model : null;
      const windowTokens = claudeModelWindow(model);
      const usage = message.usage;
      if (!usage || typeof usage !== "object" || windowTokens == null) {
        latest = unavailableContextUsage("claude", model);
        return latest;
      }
      const fields = [
        usage.input_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
        usage.output_tokens,
      ];
      if (!fields.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
        latest = unavailableContextUsage("claude", model);
        return latest;
      }
      latest = reportedContextUsage({
        agent: "claude",
        model,
        usedTokens: fields.reduce((sum, value) => sum + value, 0),
        windowTokens,
        measuredAt: recordMeasuredAt(record, now),
      });
      return latest;
    },
    current() { return latest; },
  };
}

export function parseClaudeTranscript(text, options) {
  const parser = createClaudeParser(options);
  for (const line of String(text || "").split("\n")) if (line.trim()) parser.pushLine(line);
  return parser.current();
}
