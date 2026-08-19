export function takeBridgeTokenFromFragment(locationValue = globalThis.location, historyValue = globalThis.history) {
  const raw = String(locationValue?.hash || "").replace(/^#/, "");
  const params = new URLSearchParams(raw);
  if (!params.has("bridge")) return null;
  const token = params.get("bridge") || "";
  const port = Number(params.get("bridge_port") || "");
  params.delete("bridge");
  params.delete("bridge_port");
  const remainder = params.toString();
  const nextUrl = `${locationValue.pathname}${locationValue.search}${remainder ? `#${remainder}` : ""}`;
  historyValue.replaceState(historyValue.state, "", nextUrl);
  return { token, ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}) };
}
