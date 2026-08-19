import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBridge } from "../../src/node/bridge/server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_CLAUDE = path.join(ROOT, "test/integration/fixtures/fake-claude.mjs");
const FAKE_CODEX = path.join(ROOT, "test/integration/fixtures/fake-codex.mjs");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-bridge-http-"));
const home = path.join(temporaryRoot, "home");
const data = path.join(temporaryRoot, "data");
const claudeRecord = path.join(temporaryRoot, "claude.ndjson");
const codexRecord = path.join(temporaryRoot, "codex.ndjson");
const codexArgsRecord = path.join(temporaryRoot, "codex-args.ndjson");
await fs.mkdir(path.join(home, ".codex"), { recursive: true });
await fs.writeFile(path.join(home, ".codex", "auth.json"), "{}\n");

function request(bridge, {
  method = "GET",
  pathname = "/v1/models",
  headers = {},
  body,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: bridge.port,
      method,
      path: pathname,
      headers,
    }, (res) => {
      res.setEncoding("utf8");
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let json;
        if (raw) {
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.once("error", reject);
    req.end(body);
  });
}

function authHeaders(bridge, extra = {}) {
  return {
    Authorization: `Bearer ${bridge.token}`,
    ...extra,
  };
}

async function chat(bridge, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return request(bridge, {
    method: "POST",
    pathname: "/v1/chat/completions",
    headers: authHeaders(bridge, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...headers,
    }),
    body,
  });
}

async function firstSseState(bridge) {
  const controller = new AbortController();
  const response = await fetch(`${bridge.url}/bridge/events`, {
    headers: authHeaders(bridge),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (!raw.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    raw += decoder.decode(chunk.value, { stream: true });
  }
  controller.abort();
  const data = raw.split(/\r?\n/).find((line) => line.startsWith("data: "));
  return JSON.parse(data.slice(6));
}

let bridge;
try {
  bridge = await createBridge({
    port: 0,
    env: {
      ...process.env,
      HOME: home,
      RABBITHOLE_DIR: data,
      RABBITHOLE_BRIDGE_CLAUDE_BIN: FAKE_CLAUDE,
      RABBITHOLE_BRIDGE_CODEX_BIN: FAKE_CODEX,
      FAKE_CLAUDE_RECORD: claudeRecord,
      FAKE_CODEX_RECORD: codexRecord,
      FAKE_CODEX_APP_SERVER_ARGS: codexArgsRecord,
      CLAUDE_CONFIG_DIR: path.join(temporaryRoot, "must-not-be-used"),
    },
    version: "0.4.0-test",
    stateRefreshMs: 60_000,
  });
  await bridge.start();
  await bridge.refreshState();

  const seventeenMiB = Buffer.alloc(17 * 1024 * 1024, 0x20);
  const rows = [
    {
      name: "no token",
      run: () => request(bridge),
      status: 401,
      code: "unauthorized",
    },
    {
      name: "wrong token",
      run: () => request(bridge, { headers: { Authorization: "Bearer wrong" } }),
      status: 401,
      code: "unauthorized",
    },
    {
      name: "foreign origin",
      run: () => request(bridge, {
        headers: authHeaders(bridge, { Origin: "https://attacker.example" }),
      }),
      status: 403,
      code: "forbidden_origin",
    },
    {
      name: "foreign host",
      run: () => request(bridge, {
        headers: authHeaders(bridge, { Host: "attacker.example" }),
      }),
      status: 403,
      code: "forbidden_host",
    },
    {
      name: "text content type",
      run: () => request(bridge, {
        method: "POST",
        pathname: "/v1/chat/completions",
        headers: authHeaders(bridge, { "Content-Type": "text/plain" }),
        body: "{}",
      }),
      status: 415,
      code: "unsupported_media_type",
    },
    {
      name: "17 MiB body",
      run: () => request(bridge, {
        method: "POST",
        pathname: "/v1/chat/completions",
        headers: authHeaders(bridge, {
          "Content-Type": "application/json",
          "Content-Length": seventeenMiB.length,
        }),
        body: seventeenMiB,
      }),
      status: 413,
      code: "payload_too_large",
    },
    {
      name: "native no origin",
      run: () => request(bridge, { headers: authHeaders(bridge) }),
      status: 200,
    },
    {
      name: "allowed preflight",
      run: () => request(bridge, {
        method: "OPTIONS",
        pathname: "/v1/chat/completions",
        headers: {
          Origin: "https://rabbithole.ing",
          "Access-Control-Request-Headers": "authorization, content-type",
          "Access-Control-Request-Private-Network": "true",
        },
      }),
      status: 204,
      lna: "true",
    },
    {
      name: "foreign preflight",
      run: () => request(bridge, {
        method: "OPTIONS",
        pathname: "/v1/chat/completions",
        headers: { Origin: "https://attacker.example" },
      }),
      status: 403,
      code: "forbidden_origin",
      noAcao: true,
    },
    // /bridge/ping is the one unauthenticated route: the pre-pairing panel
    // needs a CORS-readable liveness answer. Host/Origin gates still apply,
    // and it must reveal nothing beyond {"ok":true}.
    {
      name: "ping no token allowed origin",
      run: () => request(bridge, {
        pathname: "/bridge/ping",
        headers: { Origin: "https://rabbithole.ing" },
      }),
      status: 200,
      acao: "https://rabbithole.ing",
    },
    {
      name: "ping foreign origin",
      run: () => request(bridge, {
        pathname: "/bridge/ping",
        headers: { Origin: "https://attacker.example" },
      }),
      status: 403,
      code: "forbidden_origin",
      noAcao: true,
    },
    {
      name: "ping foreign host",
      run: () => request(bridge, {
        pathname: "/bridge/ping",
        headers: { Host: "attacker.example" },
      }),
      status: 403,
      code: "forbidden_host",
      noAcao: true,
    },
  ];

  const observed = [];
  for (const row of rows) {
    const result = await row.run();
    assert.equal(result.status, row.status, row.name);
    if (row.code) assert.equal(result.json?.error?.code, row.code, row.name);
    if (row.lna) {
      assert.equal(result.headers["access-control-allow-private-network"], row.lna);
    }
    if (row.noAcao || row.code === "unauthorized") {
      assert.equal(result.headers["access-control-allow-origin"], undefined);
    }
    if (row.acao) assert.equal(result.headers["access-control-allow-origin"], row.acao, row.name);
    observed.push({
      name: row.name,
      status: result.status,
      code: result.json?.error?.code || null,
      lna: result.headers["access-control-allow-private-network"] || null,
      acao: result.headers["access-control-allow-origin"] || null,
    });
  }
  assert.equal(observed.length, rows.length, "acceptance E capture must include every gate row");
  process.stdout.write(`acceptance E ${JSON.stringify(observed)}\n`);

  const allowedUnauthorized = await request(bridge, {
    headers: { Origin: "https://rabbithole.ing" },
  });
  assert.equal(allowedUnauthorized.status, 401);
  assert.equal(allowedUnauthorized.headers["access-control-allow-origin"], undefined);

  const ping = await request(bridge, { pathname: "/bridge/ping" });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json, { ok: true }, "ping reveals nothing beyond liveness");

  const deletedStatus = await request(bridge, {
    pathname: "/bridge/status",
    headers: authHeaders(bridge),
  });
  assert.equal(deletedStatus.status, 404);

  const state = await firstSseState(bridge);
  assert.equal(state.bridge, "0.4.0-test");
  assert.equal(state.agents.length, 2);
  for (const agent of state.agents) {
    assert.equal(agent.state, "ready");
    assert.ok(agent.models.length > 0);
    assert.equal(Object.hasOwn(agent, "fix"), false);
  }

  const models = await request(bridge, { headers: authHeaders(bridge) });
  assert.equal(models.status, 200);
  assert.equal(models.json.object, "list");
  assert.equal(models.json.data.find((model) => model.id === "codex/gpt-fake").images, true);
  assert.equal(models.json.data.find((model) => model.id === "codex/gpt-second").images, false);

  const claude = await chat(bridge, {
    model: "claude/sonnet",
    messages: [{ role: "user", content: "Say OK" }],
    stream: false,
    reasoning_effort: "high",
  });
  assert.equal(claude.status, 200);
  assert.equal(claude.json.choices[0].message.content, "OK");
  const claudeCall = JSON.parse((await fs.readFile(claudeRecord, "utf8")).trim().split("\n").at(-1));
  assert.equal(claudeCall.claudeConfigDir, undefined);
  assert.equal(claudeCall.args.includes("--bare"), false);
  assert.deepEqual(
    claudeCall.args.slice(claudeCall.args.indexOf("--model"), claudeCall.args.indexOf("--model") + 4),
    ["--model", "sonnet", "--effort", "high"]
  );

  const codex = await chat(bridge, {
    model: "codex/gpt-fake",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Read the image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID", detail: "high" } },
      ],
    }],
    stream: false,
    reasoning_effort: "xhigh",
  });
  assert.equal(codex.status, 200);
  assert.equal(codex.json.choices[0].message.content, "OK");
  const codexCall = JSON.parse((await fs.readFile(codexRecord, "utf8")).trim().split("\n").at(-1));
  assert.equal(codexCall.model, "gpt-fake");
  assert.equal(codexCall.effort, "xhigh");
  assert.deepEqual(codexCall.input[1], {
    type: "image",
    url: "data:image/png;base64,AQID",
    detail: "high",
  });

  const noImages = await chat(bridge, {
    model: "codex/gpt-second",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Read this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    }],
    stream: false,
  });
  assert.equal(noImages.status, 400);
  assert.equal(noImages.json.error.code, "model_no_images");

  const configPath = path.join(data, "codex-home", "config.toml");
  const config = await fs.readFile(configPath, "utf8");
  assert.equal(config.includes("mcp_servers"), false);
  assert.equal(await fs.readlink(path.join(data, "codex-home", "auth.json")),
    path.join(home, ".codex", "auth.json"));
  const codexLaunch = JSON.parse((await fs.readFile(codexArgsRecord, "utf8")).trim().split("\n")[0]);
  assert.deepEqual(codexLaunch.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(codexLaunch.codexHome, path.join(data, "codex-home"));
  await assert.rejects(fs.access(path.join(data, "codex-models.json")));
} finally {
  await bridge?.close();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("bridge http ok\n");
