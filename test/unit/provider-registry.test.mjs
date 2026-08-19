import assert from "node:assert/strict";
import { PROVIDERS, providerFor, defaultBrainSettings, settingsForProvider } from "../../src/web/brain/provider-registry.js";

/* The Local preset shipped as id "custom". Saved settings and holes still carry that value. */
assert.equal(providerFor("custom").id, "local", "legacy Local settings must keep resolving to Local");
assert.equal(providerFor("local").id, "local");
assert.equal(providerFor("custom_endpoint").id, "custom_endpoint");
assert.equal(providerFor("nonsense").id, "openrouter", "unknown providers fall back to the recommended one");
assert.equal(providerFor(undefined).id, "openrouter");

assert.deepEqual(Object.values(PROVIDERS).map((provider) => provider.label), ["OpenRouter", "CC/Codex", "Local", "Custom"]);
assert.equal(providerFor("subscriptions").id, "subscriptions");
assert.equal(PROVIDERS.subscriptions.requires_key, false, "subscriptions authenticate through the local helper, never a key");
assert.equal(PROVIDERS.subscriptions.base_url, "http://127.0.0.1:41414/v1", "the helper owns a fixed loopback port");
assert.equal(PROVIDERS.subscriptions.model, "", "no subscription model can be assumed before the helper reports one");
assert.equal(PROVIDERS.custom_endpoint.requires_key, false, "a custom endpoint may have no auth at all");
assert.equal(PROVIDERS.custom_endpoint.allows_key, true, "a custom endpoint must still be able to send a key");
assert.equal(PROVIDERS.custom_endpoint.requires_base_url, true);
assert.equal(PROVIDERS.custom_endpoint.base_url, "", "the custom endpoint must not ship a guessed URL");
assert.equal(PROVIDERS.local.base_url, "http://localhost:11434/v1", "Local keeps its Ollama default");

const defaults = defaultBrainSettings();
assert.equal(defaults.preset, "openrouter", "first run still lands on OpenRouter");

/* Switching providers must not discard what was typed into the other ones. */
let settings = { ...defaults };
settings = settingsForProvider("custom_endpoint", settings);
assert.equal(settings.base_url, "");
settings = { ...settings, base_url: "https://api.example.com/v1", model: "my-model", transcribe_model: "my-vision" };
settings = settingsForProvider("openrouter", settings);
assert.equal(settings.base_url, "https://openrouter.ai/api/v1", "OpenRouter restores its own endpoint");
assert.equal(settings.model, "anthropic/claude-sonnet-5");
settings = settingsForProvider("custom_endpoint", settings);
assert.equal(settings.base_url, "https://api.example.com/v1", "a typed endpoint survives a round trip through another provider");
assert.equal(settings.model, "my-model");
assert.equal(settings.transcribe_model, "my-vision");

settings = settingsForProvider("local", settings);
assert.equal(settings.base_url, "http://localhost:11434/v1");
assert.equal(settings.model, "llama3.2");
settings = settingsForProvider("custom_endpoint", settings);
assert.equal(settings.base_url, "https://api.example.com/v1", "Local must not clobber the custom endpoint slot");

/* Subscription agent picks are per-provider and per-agent state. */
settings = settingsForProvider("subscriptions", settings);
settings = {
  ...settings,
  agent: "claude",
  model: "claude/sonnet",
  reasoning: "xhigh",
  agents: {
    claude: { model: "claude/sonnet", reasoning: "xhigh", transcribe_model: "claude/sonnet" },
    codex: { model: "codex/gpt-5.6-sol", reasoning: "low", transcribe_model: "" },
  },
};
settings = settingsForProvider("openrouter", settings);
assert.equal(settings.reasoning, "", "OpenRouter has no reasoning selection");
assert.equal(settings.agent, "", "subscription-only state does not leak into another provider");
settings = settingsForProvider("subscriptions", settings);
assert.equal(settings.model, "claude/sonnet", "the chosen subscription model survives a provider round trip");
assert.equal(settings.reasoning, "xhigh", "the chosen reasoning effort survives a provider round trip");
assert.equal(settings.agent, "claude");
assert.deepEqual(settings.agents.codex, {
  model: "codex/gpt-5.6-sol",
  reasoning: "low",
  transcribe_model: "",
}, "each agent keeps its own model and reasoning");

/* A legacy slot keyed by the old id has to land in the Local slot, not vanish. */
const legacy = settingsForProvider("local", {
  preset: "openrouter",
  base_url: "https://openrouter.ai/api/v1",
  model: "anthropic/claude-sonnet-5",
  providers: { custom: { base_url: "http://127.0.0.1:11434/v1", model: "qwen3", transcribe_model: "qwen3" } },
});
assert.equal(legacy.base_url, "http://127.0.0.1:11434/v1", "a legacy per-provider slot migrates to Local");
assert.equal(legacy.model, "qwen3");

process.stdout.write("provider-registry ok\n");
