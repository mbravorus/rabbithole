/* SPEC-SUBS.md §5.2: a CLOSED set of pure indirections that name no model. Every other alias the
   CLI reports is passed through — `opusplan` especially, which is a distinct routing mode (Opus
   plans, Sonnet executes), not a synonym. Do not extend this set without updating the spec. */
const ALIAS_INDIRECTIONS = new Set(["best", "default"]);

export const CLAUDE_REASONING = Object.freeze({
  options: ["low", "medium", "high", "xhigh", "max"],
  default: "medium",
});

export function parseClaudeAliases(value) {
  const text = typeof value === "string" ? value : value?.result;
  if (typeof text !== "string") return [];
  const available = text.match(/Available:([\s\S]*)/i)?.[1] || "";
  const aliases = available
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias && !/\s/.test(alias))
    .filter((alias) => !ALIAS_INDIRECTIONS.has(alias.toLowerCase()));
  return [...new Set(aliases)];
}

/* SPEC-SUBS.md §5.2: derive the label from the alias — never a version-number table. A baked-in
   "Sonnet 5" becomes actively false the day Sonnet 6 ships, and a wrong version reads as
   authoritative. The alias is the only durable identity the CLI gives us. */
export function claudeAliasDisplayName(alias) {
  const oneMillion = /\[1m\]$/i.test(alias);
  const base = alias.replace(/\[1m\]$/i, "").toLowerCase();
  const clean = base.split(/[-_]/).filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
  return `${clean}${oneMillion ? " · 1M context" : ""}`;
}

export function claudeModelEntries(aliases) {
  return aliases.map((alias) => ({
    id: `claude/${alias}`,
    object: "model",
    owned_by: "claude-code",
    name: claudeAliasDisplayName(alias),
    reasoning: {
      options: [...CLAUDE_REASONING.options],
      default: CLAUDE_REASONING.default,
    },
    images: true,
  }));
}

export function codexModelEntry(model) {
  const options = (model.supportedReasoningEfforts || [])
    .map((effort) => typeof effort === "string" ? effort : effort?.reasoningEffort)
    .filter(Boolean);
  const defaultEffort = model.defaultReasoningEffort || options[0] || "medium";
  const images = Array.isArray(model.inputModalities) && model.inputModalities.includes("image");
  return {
    id: `codex/${model.model}`,
    object: "model",
    owned_by: "codex",
    name: model.displayName || model.name || model.model,
    reasoning: {
      options: options.length ? [...new Set(options)] : [defaultEffort],
      default: defaultEffort,
    },
    images,
  };
}

export function routeModelId(modelId) {
  if (typeof modelId !== "string") return null;
  const match = /^(claude|codex)\/(.+)$/.exec(modelId);
  if (!match) return null;
  return { backend: match[1], model: match[2] };
}
