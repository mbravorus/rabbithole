import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import {
  readSseJsonFrames,
  spawnBridgeProcess,
  withTimeout,
} from "./bridge-live-support.mjs";
import { assertNoDeletedSubscriptionMechanisms } from "../test/support/subscription-source-guard.mjs";

const EXPECTED_ANSWER = "RABBIT 7319";
const IMAGE_DESCRIPTION = "uppercase RABBIT over the number 7319";
const READY_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 300_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const FORBIDDEN_LOG_PATTERN = /app-server unresponsive|static model fallback/i;

function createTestPng() {
  const canvas = createCanvas(640, 360);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111827";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "bold 96px sans-serif";
  context.fillText("RABBIT", canvas.width / 2, 120);
  context.font = "bold 112px sans-serif";
  context.fillText("7319", canvas.width / 2, 255);
  const png = canvas.toBuffer("image/png");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return png;
}

function stateSummary(state) {
  return state?.agents?.map((agent) => `${agent.id}:${agent.state}`).join(",") || "invalid";
}

async function readReadyState(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READY_TIMEOUT_MS);
  const frames = [];
  try {
    const response = await fetch(`${url}/bridge/events`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    assert.equal(response.status, 200, `bridge events returned HTTP ${response.status}`);
    assert.ok(response.body, "bridge events response had no body");
    const ready = await readSseJsonFrames(response, (state) => {
      frames.push(state);
      return (
        state.agents?.every((agent) => agent.state === "ready")
        || state.agents?.some((agent) => !["starting", "ready"].includes(agent.state))
      )
        ? state
        : undefined;
    });
    if (ready) {
      const unavailableAgents = ready.agents.filter((agent) => (
        !["starting", "ready"].includes(agent.state)
      ));
      assert.equal(
        unavailableAgents.length,
        0,
        `bridge backend unavailable before vision turns: ${unavailableAgents.map((agent) => (
          `${agent.id} state=${agent.state} fix=${JSON.stringify(agent.fix)}`
        )).join(", ")}`,
      );
      return ready;
    }
    throw new Error(`bridge stream closed before ready: ${frames.map(stateSummary).join(" -> ")}`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`bridge did not become ready within ${READY_TIMEOUT_MS}ms: ${frames.map(stateSummary).join(" -> ")}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function chooseVisionModel(state, agentId) {
  const models = state.agents.find((agent) => agent.id === agentId)?.models || [];
  const visionModels = models.filter((model) => model.images === true);
  assert.ok(visionModels.length, `${agentId} did not report a vision-capable model`);
  if (agentId === "claude") {
    return visionModels.find((model) => model.id === "claude/sonnet") || visionModels[0];
  }
  return visionModels[0];
}

async function readChatStream(response, backend) {
  if (!response.ok) {
    throw new Error(`${backend} vision request returned HTTP ${response.status}: ${await response.text()}`);
  }
  assert.ok(response.body, `${backend} vision response had no body`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let answer = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
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
      if (data === "[DONE]") {
        done = true;
        break;
      }
      const frame = JSON.parse(data);
      if (frame.error) {
        throw new Error(`${backend} vision turn failed (${frame.error.code}): ${frame.error.message}`);
      }
      answer += frame.choices?.[0]?.delta?.content || "";
    }
  }
  assert.equal(done, true, `${backend} vision stream ended without [DONE]`);
  return answer.trim();
}

async function runVisionTurn({ url, token, backend, model, imageDataUrl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const prompt = "Read the image. It contains one uppercase English word and one four-digit number on separate lines. Reply with exactly the word, one space, and the number. Do not infer them from this request.";
  try {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
          ],
        }],
        stream: true,
        reasoning_effort: model.reasoning?.options?.includes("low")
          ? "low"
          : model.reasoning?.default,
      }),
      signal: controller.signal,
    });
    const answer = await readChatStream(response, backend);
    assert.equal(
      answer.toUpperCase(),
      EXPECTED_ANSWER,
      `${backend} did not read the generated image correctly`,
    );
    return answer;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${backend} vision turn exceeded ${TURN_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

await assertNoDeletedSubscriptionMechanisms();

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-vision-live-"));
const bridgeDirectory = path.join(temporaryRoot, "bridge-data");
const cachePath = path.join(bridgeDirectory, "codex-models.json");
const cacheExistedBefore = await fs.access(cachePath).then(() => true, () => false);

const bridgeEnv = { ...process.env, RABBITHOLE_DIR: bridgeDirectory };
delete bridgeEnv.RABBITHOLE_BRIDGE_CLAUDE_BIN;
delete bridgeEnv.RABBITHOLE_BRIDGE_CODEX_BIN;
delete bridgeEnv.CODEX_HOME;
delete bridgeEnv.CLAUDE_CONFIG_DIR;

const bridgeRun = spawnBridgeProcess({
  env: bridgeEnv,
  earlyExitError: ({ code, signal }) => new Error(
    `bridge exited before startup (code=${code}, signal=${signal})`
  ),
});
const bridgeProcess = bridgeRun.child;
const bridgeExit = bridgeRun.exit;

let answers;
let failure;
try {
  const connection = await withTimeout(
    bridgeRun.startup,
    READY_TIMEOUT_MS,
    "bridge did not print its ephemeral URL and pairing token",
  );
  const readyState = await readReadyState(connection.url, connection.token);
  const png = createTestPng();
  const imageDataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const claudeModel = chooseVisionModel(readyState, "claude");
  const codexModel = chooseVisionModel(readyState, "codex");
  const claudeAnswer = await runVisionTurn({
    ...connection,
    backend: "claude",
    model: claudeModel,
    imageDataUrl,
  });
  const codexAnswer = await runVisionTurn({
    ...connection,
    backend: "codex",
    model: codexModel,
    imageDataUrl,
  });
  answers = [
    { backend: "claude", model: claudeModel.id, answer: claudeAnswer },
    { backend: "codex", model: codexModel.id, answer: codexAnswer },
  ];
} catch (error) {
  failure = error;
}

if (bridgeProcess.exitCode === null && bridgeProcess.signalCode === null) {
  bridgeProcess.kill("SIGTERM");
}
try {
  await withTimeout(bridgeExit, SHUTDOWN_TIMEOUT_MS, "bridge did not shut down after the live vision check");
} catch (error) {
  failure ||= error;
  if (bridgeProcess.exitCode === null && bridgeProcess.signalCode === null) bridgeProcess.kill("SIGKILL");
}

const forbiddenLogs = bridgeRun.stderr().split(/\r?\n/).filter((line) => FORBIDDEN_LOG_PATTERN.test(line));
const cacheExistsAfter = await fs.access(cachePath).then(() => true, () => false);
if (!failure && forbiddenLogs.length) {
  failure = new Error(`bridge emitted forbidden fallback logs: ${JSON.stringify(forbiddenLogs)}`);
}
if (!failure && cacheExistsAfter) {
  failure = new Error("live vision check created the forbidden bridge model cache");
}
await fs.rm(temporaryRoot, { recursive: true, force: true });

if (failure) {
  const redactedLogs = bridgeRun.stderr().trim()
    .split(/\r?\n/)
    .slice(-30)
    .join("\n")
    .replace(/[a-f0-9]{64}/g, "<redacted>");
  throw new Error(`${failure.message}${redactedLogs ? `\nbridge stderr:\n${redactedLogs}` : ""}`, {
    cause: failure,
  });
}

for (const result of answers) {
  process.stdout.write(
    `acceptance F backend=${result.backend} model=${result.model} `
    + `image="${IMAGE_DESCRIPTION}" answer=${JSON.stringify(result.answer)}\n`,
  );
}
process.stdout.write(
  `acceptance F cache_before=${cacheExistedBefore} cache_after=${cacheExistsAfter} `
  + `catalog_shim=false forbidden_logs=${JSON.stringify(forbiddenLogs)}\n`,
);
