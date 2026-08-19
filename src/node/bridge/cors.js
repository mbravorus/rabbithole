const PRODUCTION_ORIGINS = new Set(["https://rabbithole.ing"]);

export function isAllowedOrigin(origin) {
  if (typeof origin !== "string") return false;
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return false;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "7200");
}
