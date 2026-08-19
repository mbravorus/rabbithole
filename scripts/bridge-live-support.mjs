import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function spawnBridgeProcess({
  env = process.env,
  maxStderrBytes = Infinity,
  earlyExitError,
} = {}) {
  let startupResolve;
  let startupReject;
  const startup = new Promise((resolve, reject) => {
    startupResolve = resolve;
    startupReject = reject;
  });
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "bin/rabbithole.js"), "bridge", "--port", "0"],
    {
      cwd: ROOT,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let stderr = "";
  let stderrPending = "";
  let bridgeUrl;
  let bridgeToken;
  let startupSettled = false;
  const maybeResolveStartup = () => {
    if (startupSettled || !bridgeUrl || !bridgeToken) return;
    startupSettled = true;
    startupResolve({ url: bridgeUrl, token: bridgeToken });
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < maxStderrBytes) {
      stderr += chunk.slice(0, maxStderrBytes - stderr.length);
    }
    stderrPending += chunk;
    const lines = stderrPending.split(/\r?\n/);
    stderrPending = lines.pop() || "";
    for (const line of lines) {
      bridgeUrl ||= line.match(
        /Rabbithole bridge listening on (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1];
      bridgeToken ||= line.match(/Pairing token: ([a-f0-9]{64})/)?.[1];
    }
    maybeResolveStartup();
  });
  exit.then(({ code, signal }) => {
    if (startupSettled) return;
    startupSettled = true;
    startupReject(earlyExitError({ code, signal, stderr }));
  }, startupReject);

  return {
    child,
    exit,
    startup,
    stderr: () => stderr,
  };
}

export async function readSseJsonFrames(response, onFrame) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return undefined;
    pending += decoder.decode(chunk.value, { stream: true });
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(pending);
      if (!boundary) break;
      const block = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const result = onFrame(JSON.parse(data));
      if (result !== undefined) {
        await reader.cancel();
        return result;
      }
    }
  }
}
