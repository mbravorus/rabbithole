import { serveStatic } from "./static-server.mjs";

const server = await serveStatic(new URL("../../web/dist", import.meta.url).pathname, { spaFallback: true });
console.log(`serving web/dist at http://127.0.0.1:${server.address().port}`);
