import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function filesBelow(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

const FORBIDDEN_MECHANISMS = [
  {
    name: "codex exec generation fallback",
    pattern: /\bcodex\s+exec\b|(?:spawn|execFile|runCaptured)\s*\([\s\S]{0,200}?\[\s*["'`]exec["'`]/i,
  },
  {
    name: "static Codex model table",
    pattern: /\bSTATIC_CODEX_MODELS\b|(?:const|let|var)\s+\w*(?:codex\w*models|models\w*codex)\s*=\s*(?:Object\.freeze\s*\(\s*)?\[|\[\s*\{[\s\S]{0,500}?\bid\s*:\s*["'`]codex\//i,
  },
  {
    name: "Codex model-cache write",
    pattern: /codex-models\.json|\b(?:writeFile|appendFile|createWriteStream)\s*\([\s\S]{0,200}?(?:model.?cache|codex.?models)/i,
  },
];

export async function assertNoDeletedSubscriptionMechanisms({ root = ROOT } = {}) {
  const roots = ["src", "bin"].map((directory) => path.join(root, directory));
  const files = (await Promise.all(roots.map(filesBelow))).flat().sort();
  assert.ok(files.length > 0, "subscription source guard must inspect source files");

  const sources = await Promise.all(files.map(async (file) => ({
    file: path.relative(root, file),
    source: await fs.readFile(file, "utf8"),
  })));
  const codexBridge = sources.find(({ file }) => file === "src/node/bridge/codex.js");
  assert.match(
    codexBridge?.source || "",
    /class CodexAppServer[\s\S]*?model\/list/,
    "subscription source guard must read the live Codex app-server implementation"
  );

  const violations = [];
  for (const { file, source } of sources) {
    for (const mechanism of FORBIDDEN_MECHANISMS) {
      if (mechanism.pattern.test(source)) {
        violations.push(`${file}: ${mechanism.name}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `SPEC-SUBS §9 mechanism reintroduced:\n${violations.join("\n")}`
  );
  return { files: files.length };
}
