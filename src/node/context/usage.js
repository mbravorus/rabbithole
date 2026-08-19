function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function unavailableContextUsage(agent = null, model = null) {
  return {
    type: "context_usage",
    quality: "unavailable",
    agent,
    model,
    used_tokens: null,
    window_tokens: null,
    percent: null,
    measured_at: null,
  };
}

export function reportedContextUsage({ agent, model, usedTokens, windowTokens, measuredAt }) {
  if (!nonNegativeNumber(usedTokens) || !nonNegativeNumber(windowTokens) || windowTokens <= 0 || usedTokens > windowTokens) {
    return unavailableContextUsage(agent, model);
  }
  return {
    type: "context_usage",
    quality: "reported",
    agent,
    model: typeof model === "string" && model ? model : null,
    used_tokens: usedTokens,
    window_tokens: windowTokens,
    // This is the literal cross-agent fraction. Codex's own TUI currently
    // subtracts a reserved baseline before displaying context left.
    percent: Math.min(100, Math.max(0, 100 * usedTokens / windowTokens)),
    measured_at: measuredAt,
  };
}

export function recordMeasuredAt(record, now = () => new Date()) {
  const candidate = record?.timestamp ?? record?.payload?.timestamp;
  if (typeof candidate === "string" && Number.isFinite(Date.parse(candidate))) {
    return new Date(candidate).toISOString();
  }
  return now().toISOString();
}
