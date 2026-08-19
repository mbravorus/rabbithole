import { defaultBrainSettings, normalizeProviderSettings, providerFor } from "../brain/provider-registry.js";
import { saveApiKey } from "./credential-store.js";

export const SETTINGS_KEY = "rh-web-settings";
const DEFAULT_FETCH_PROXY_URL =
  typeof __RABBITHOLE_DEFAULT_PROXY_URL__ === "string" ? __RABBITHOLE_DEFAULT_PROXY_URL__ : "";

function defaultWebSettings() {
  return { ...defaultBrainSettings(), fetch_proxy_url: DEFAULT_FETCH_PROXY_URL || "" };
}

export function loadSettings() {
  const defaults = defaultWebSettings();
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const preset = providerFor(parsed.preset).id;
    const providers = normalizeProviderSettings(parsed.providers, { [preset]: parsed });
    const active = providers[preset] || normalizeProviderSettings({ [preset]: parsed })[preset];
    providers[preset] = active;
    return { ...defaults, ...parsed, agent: "", agents: {}, preset, ...active, providers };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  const preset = providerFor(settings.preset).id;
  const providers = normalizeProviderSettings(settings.providers);
  providers[preset] = normalizeProviderSettings({ [preset]: settings })[preset];
  const { api_key, ...persistable } = { ...settings, preset, providers };
  if (persistable.fetch_proxy_url === DEFAULT_FETCH_PROXY_URL) delete persistable.fetch_proxy_url;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
  saveApiKey({ ...settings, preset, api_key });
}
