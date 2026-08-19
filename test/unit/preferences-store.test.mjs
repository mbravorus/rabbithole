import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const { getApiKey } = await import("../../src/web/settings/credential-store.js");
const { loadSettings, saveSettings } = await import("../../src/web/settings/preferences-store.js");
const { settingsForProvider } = await import("../../src/web/brain/provider-registry.js");
const { takeBridgeTokenFromFragment } = await import("../../src/web/settings/bridge-pairing.js");

const SETTINGS_KEY = "rh-web-settings";
const LEGACY_KEY = "rh-web-api-key";
const KEYS_KEY = "rh-web-api-keys";
const read = () => JSON.parse(store.get(SETTINGS_KEY) || "{}");
const readKeys = () => JSON.parse(store.get(KEYS_KEY) || "{}");

/* Settings written before the rename must keep working, pointed at Local. */
store.set(SETTINGS_KEY, JSON.stringify({
  preset: "custom",
  base_url: "http://localhost:11434/v1",
  model: "llama3.2",
  transcribe_model: "llama3.2-vision",
  session_only: true,
}));
let settings = loadSettings();
assert.equal(settings.preset, "local", "the legacy Local id is migrated on read");
assert.equal(settings.base_url, "http://localhost:11434/v1");
assert.equal(settings.model, "llama3.2");
assert.equal(settings.transcribe_model, "llama3.2-vision");
assert.equal(settings.session_only, true, "unrelated preferences survive the migration");

/* A configured custom endpoint round-trips through storage, key excluded. */
store.clear();
saveSettings({
  ...settingsForProvider("custom_endpoint", loadSettings()),
  base_url: "https://api.example.com/v1",
  model: "my-model",
  transcribe_model: "my-model",
  api_key: "secret",
  session_only: true,
});
assert.equal(read().api_key, undefined, "the key never lands in the settings blob");
settings = loadSettings();
assert.equal(settings.preset, "custom_endpoint");
assert.equal(settings.base_url, "https://api.example.com/v1");
assert.equal(settings.model, "my-model");

/* Switching to OpenRouter and back must not wipe the typed endpoint. */
saveSettings(settingsForProvider("openrouter", loadSettings()));
settings = loadSettings();
assert.equal(settings.base_url, "https://openrouter.ai/api/v1");
saveSettings(settingsForProvider("custom_endpoint", loadSettings()));
settings = loadSettings();
assert.equal(settings.base_url, "https://api.example.com/v1", "the endpoint survives a trip through OpenRouter");
assert.equal(settings.model, "my-model");

saveSettings(settingsForProvider("local", loadSettings()));
settings = loadSettings();
assert.equal(settings.base_url, "http://localhost:11434/v1", "Local restores its own endpoint");
saveSettings(settingsForProvider("custom_endpoint", loadSettings()));
assert.equal(loadSettings().base_url, "https://api.example.com/v1", "Local must not overwrite the custom slot");

/* The Subscriptions slot retains the selected agent and each agent's choices. */
saveSettings({
  ...settingsForProvider("subscriptions", loadSettings()),
  agent: "codex",
  token: "paired-token",
  model: "codex/gpt-5.6-sol",
  reasoning: "low",
  agents: {
    claude: { model: "claude/opus", reasoning: "high", transcribe_model: "claude/opus" },
    codex: { model: "codex/gpt-5.6-sol", reasoning: "low", transcribe_model: "" },
  },
});
settings = loadSettings();
assert.equal(settings.agent, "codex");
assert.equal(settings.token, "paired-token");
assert.equal(settings.agents.claude.model, "claude/opus");
assert.equal(settings.agents.codex.reasoning, "low");
saveSettings(settingsForProvider("openrouter", settings));
assert.equal(loadSettings().agent, "");
saveSettings(settingsForProvider("subscriptions", loadSettings()));
assert.equal(loadSettings().agent, "codex");
assert.equal(loadSettings().agents.claude.reasoning, "high");
assert.equal(loadSettings().token, "paired-token");

/* An active provider slot falls back to legacy top-level values field by field. */
store.set(SETTINGS_KEY, JSON.stringify({
  preset: "subscriptions",
  base_url: "http://127.0.0.1:41414/v1",
  model: "claude/legacy-model",
  transcribe_model: "claude/legacy-vision",
  reasoning: "high",
  token: "legacy-token",
  agents: { claude: { model: "claude/top-level", reasoning: "xhigh" } },
  providers: {
    subscriptions: {
      agent: "claude",
      agents: { claude: { transcribe_model: "claude/slot-vision" } },
    },
  },
}));
settings = loadSettings();
assert.equal(settings.model, "claude/legacy-model");
assert.equal(settings.transcribe_model, "claude/legacy-vision");
assert.equal(settings.reasoning, "high");
assert.equal(settings.token, "legacy-token");
assert.deepEqual(settings.agents.claude, {
  model: "claude/top-level",
  transcribe_model: "claude/slot-vision",
  reasoning: "xhigh",
});

/* Fragment pairing removes only bridge and leaves the remaining hash route intact. */
const pairingLocation = { pathname: "/h/example", search: "?view=canvas", hash: "#route=notes&bridge=fresh-token&tab=2" };
let replacedUrl = "";
const pairingHistory = {
  state: { preserved: true },
  replaceState(state, title, url) {
    assert.deepEqual(state, { preserved: true });
    assert.equal(title, "");
    replacedUrl = url;
  },
};
assert.deepEqual(takeBridgeTokenFromFragment(pairingLocation, pairingHistory), { token: "fresh-token" });
assert.equal(replacedUrl, "/h/example?view=canvas#route=notes&tab=2");

/* A non-default port rides along in the fragment and is stripped with the token. */
const portedLocation = { pathname: "/", search: "", hash: "#bridge=ported-token&bridge_port=41500" };
let portedUrl = "";
const portedHistory = { state: null, replaceState(_state, _title, url) { portedUrl = url; } };
assert.deepEqual(takeBridgeTokenFromFragment(portedLocation, portedHistory), { token: "ported-token", port: 41500 });
assert.equal(portedUrl, "/");

/* Omitted keys preserve remembered credentials; only an explicit clear deletes them. */
store.clear();
store.set(KEYS_KEY, JSON.stringify({ openrouter: "remembered-secret" }));
saveSettings({ ...settingsForProvider("openrouter", loadSettings()), session_only: false });
assert.equal(readKeys().openrouter, "remembered-secret");
saveSettings({ ...loadSettings(), api_key: "", session_only: false });
assert.equal(readKeys().openrouter, undefined);

/* A plausible key in the legacy slot migrates on the first credential read. */
store.clear();
const legacyKey = `sk-or-v1-${"a".repeat(24)}`;
store.set(LEGACY_KEY, legacyKey);
const legacySettings = { ...settingsForProvider("openrouter", loadSettings()), session_only: false };
assert.equal(getApiKey(legacySettings), legacyKey);
assert.equal(readKeys().openrouter, legacyKey);
assert.equal(store.has(LEGACY_KEY), false);

/* Corrupt storage falls back to defaults instead of throwing. */
store.set(SETTINGS_KEY, "not json");
assert.equal(loadSettings().preset, "openrouter");
store.set(SETTINGS_KEY, JSON.stringify(["nope"]));
assert.equal(loadSettings().preset, "openrouter");
store.set(SETTINGS_KEY, JSON.stringify({ preset: "custom_endpoint", providers: "nope" }));
assert.equal(loadSettings().preset, "custom_endpoint");
assert.equal(loadSettings().base_url, "", "a junk provider map degrades to preset defaults");

process.stdout.write("preferences-store ok\n");
