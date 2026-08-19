import { providerFor } from "../brain/provider-registry.js";

const LEGACY_KEY = "rh-web-api-key";
const KEYS_KEY = "rh-web-api-keys";
const memoryKeys = Object.create(null);

function readRememberedKeys() {
  let keys;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_KEY) || "{}");
    keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
  if (Object.prototype.hasOwnProperty.call(keys, "openrouter")) return keys;
  try {
    const legacyKey = String(localStorage.getItem(LEGACY_KEY) || "").trim();
    if (!/^sk-or-v1-[A-Za-z0-9_-]{24,}$/.test(legacyKey)) return keys;
    const migrated = { ...keys, openrouter: legacyKey };
    localStorage.setItem(KEYS_KEY, JSON.stringify(migrated));
    localStorage.removeItem(LEGACY_KEY);
    return migrated;
  } catch {
    return keys;
  }
}

function writeRememberedKeys(keys) {
  try {
    if (Object.keys(keys).length) localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
    else localStorage.removeItem(KEYS_KEY);
    return true;
  } catch {
    return false;
  }
}

export function saveApiKey(settings) {
  if (settings.api_key === undefined) return;
  const providerId = providerFor(settings.preset).id;
  const apiKey = settings.api_key || "";
  const keys = readRememberedKeys();
  if (settings.session_only === false) {
    if (apiKey) keys[providerId] = apiKey;
    else delete keys[providerId];
    writeRememberedKeys(keys);
    delete memoryKeys[providerId];
  } else {
    delete keys[providerId];
    writeRememberedKeys(keys);
    memoryKeys[providerId] = apiKey;
  }
}

export function getApiKey(settings) {
  const providerId = providerFor(settings.preset).id;
  if (settings.session_only === false) return readRememberedKeys()[providerId] || "";
  return memoryKeys[providerId] || "";
}
