import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BridgeError } from "./errors.js";
import { warn } from "../logger.js";

const CAPTURE_LIMIT = 1024 * 1024;

export function resolveExecutable(name, override, env = process.env) {
  const requested = override || name;
  const candidates = requested.includes(path.sep)
    ? [path.resolve(requested)]
    : String(env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, requested));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

export function runCaptured(executable, args, {
  cwd,
  env = process.env,
  timeoutMs = 15_000,
} = {}) {
  if (!executable) {
    return Promise.reject(new BridgeError("The requested agent CLI is not installed", "agent_missing", 503));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChild(child);
      reject(new BridgeError(`Agent command timed out after ${timeoutMs}ms`, "turn_failed", 500));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < CAPTURE_LIMIT) stdout += chunk.slice(0, CAPTURE_LIMIT - stdout.length);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = error?.code === "ENOENT" ? "agent_missing" : "turn_failed";
      warn(`Agent command failed to start: ${error.message}`);
      reject(new BridgeError(
        "Could not start the agent command. Check the installation and try again.",
        code,
        code === "agent_missing" ? 503 : 500
      ));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.stdin.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      warn(`Agent command stdin failed: ${error.message}`);
      terminateChild(child);
      reject(new BridgeError(
        "Could not send input to the agent command. Try again.",
        "turn_failed",
        500
      ));
    });

    child.stdin.end();
  });
}

export function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1000);
  timer.unref?.();
}

export function parseJsonOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const line of trimmed.split(/\r?\n/).reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Some CLIs include a harmless non-JSON line before their JSON result.
      }
    }
  }
  return null;
}
