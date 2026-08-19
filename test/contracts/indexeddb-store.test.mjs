import assert from "node:assert/strict";
import { assertRabbitholeStore } from "../../src/core/store.js";
import { IdbStore } from "../../src/web/store/idb-store.js";
import { createPendingHoleFromQuestion, DirectRabbitholeHost } from "../../src/web/transport/direct-host.js";
import { runStoreContract } from "../support/store-contract.mjs";

import "fake-indexeddb/auto";

if (typeof globalThis.FileReader !== "function") {
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      }, (error) => {
        this.error = error;
        this.onerror?.();
      });
    }
  };
}

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
  storage: {
    persist: async () => true,
  },
  },
});

await verifyFreshDatabaseInitialization();
await verifyPersistencePermissionDoesNotBlockWrites();

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    storage: {
      persist: async () => true,
    },
  },
});

const store = assertRabbitholeStore(new IdbStore({ dbName: `rabbithole-indexeddb-store-${Date.now()}` }));

await runStoreContract(store, {
  readRawHole: (holeId) => rawHole("readonly", holeId),
  writeRawHole: (_holeId, fixture) => rawHole("readwrite", fixture),
  makeDeleteHost: async ({ root, childA, childB }) => {
    const host = new DirectRabbitholeHost({
      store,
      hole: {
        hole_id: "gc-hole",
        title: "GC Hole",
        root_id: "root",
        created_at: "2026-01-01T00:00:00.000Z",
        view_state: null,
        nodes: [root, childA, childB],
      },
    });
    return {
      deleteNode: (nodeId) => host.handleDeleteNode({ node_id: nodeId }),
      close: () => host.flushSave(),
    };
  },
});

{
  const registeredAssets = [];
  const revokedAssets = [];
  const host = new DirectRabbitholeHost({
    store,
    hole: {
      hole_id: "web-note-create",
      title: "Web note create",
      root_id: "root",
      created_at: "2026-08-11T00:00:00.000Z",
      view_state: null,
      nodes: [{ id: "root", parent_id: null, title: "Root", markdown: "Root body", status: "answered" }],
    },
    registerAssetUrl: (name, blob) => registeredAssets.push({ name, blob }),
    revokeAssetUrl: (name) => revokedAssets.push(name),
  });
  const result = await host.handleBrowserEvent({
    type: "node_create",
    id: "standalone-note",
    markdown: "Durable browser note",
    position: { x: -80, y: 220 },
    origin: { kind: "note" },
  });
  assert.deepEqual(result, { ok: true, node_id: "standalone-note" });
  assert.equal(host.hydration().nodes.find((node) => node.id === "standalone-note")?.parent_id, null, "web hydration includes standalone notes");
  assert.equal((await store.loadHole("web-note-create")).nodes.find((node) => node.id === "standalone-note")?.markdown, "Durable browser note", "web node_create must persist to IndexedDB before returning");

  await host.handleBrowserEvent({ type: "delete_node", node_id: "standalone-note" });
  await host.flushSave();
  assert.equal((await store.loadHole("web-note-create")).nodes.some((node) => node.id === "standalone-note"), false, "web host deletes and persists standalone notes");

  const pastedBlob = new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" });
  assert.deepEqual(await host.adapter().putAsset("paste-web.png", pastedBlob), { ok: true, name: "paste-web.png" });
  assert.equal(registeredAssets[0].name, "paste-web.png", "the BYOK upload seam registers an immediately renderable URL");
  await assert.rejects(() => host.adapter().putAsset("figure.png", pastedBlob), /start with paste-/);
  await assert.rejects(() => host.adapter().putAsset("paste-source.pdf", pastedBlob), /image extension/);
  await assert.rejects(() => host.adapter().putAsset("paste-web.png", pastedBlob), /already exists/);

  for (let index = 1; index <= 5; index += 1) {
    await store.putAsset("web-note-create", `paste-delivery-${index}.png`, pastedBlob);
  }
  const deliveryContext = {};
  await host.attachBranchImage({ parent_id: "root", origin: { attachment_assets: [
    "source.pdf", "../escape.png", "paste-web.png", "paste-delivery-1.png", "paste-delivery-2.png",
    "paste-delivery-3.png", "paste-delivery-4.png", "paste-delivery-5.png",
  ] } }, deliveryContext);
  assert.deepEqual(deliveryContext.attachments.map((attachment) => attachment.name),
    ["paste-web.png", "paste-delivery-1.png", "paste-delivery-2.png", "paste-delivery-3.png"],
    "BYOK delivery must reject PDF/traversal names and cap persisted attachment assets at four valid images");
  const askResult = await host.handleBrowserEvent({
    type: "branch_request",
    request_id: "standalone-away-request",
    node_id: "standalone-away-ask",
    parent_id: null,
    selected_text: "",
    question: "Can this wait for a provider?",
    branch_type: "followup",
    position: { x: 180, y: -60 },
    size: { w: 300, h: 180 },
    attachment_assets: ["paste-web.png", "../bad.png"],
  });
  assert.deepEqual(askResult, {
    ok: true, node_id: "standalone-away-ask", request_id: "standalone-away-request",
  });
  const savedAsk = (await store.loadHole("web-note-create")).nodes.find((node) => node.id === "standalone-away-ask");
  assert.equal(savedAsk.parent_id, null, "a BYOK ask is durably disconnected before provider work starts");
  assert.equal(savedAsk.status, "pending", "a standalone ask remains saved while no provider is available");
  assert.equal(savedAsk.origin.question, "Can this wait for a provider?");
  assert.deepEqual(savedAsk.origin.attachment_assets, ["paste-web.png"], "the BYOK branch chokepoint keeps only durable image asset names");
  assert.deepEqual(savedAsk.position, { x: 180, y: -60 });
  assert.deepEqual(savedAsk.size, { w: 300, h: 180 });
  assert.deepEqual(await host.adapter().deleteAsset("paste-web.png"), { ok: true, name: "paste-web.png" });
  assert.equal(await store.getAsset("web-note-create", "paste-web.png"), null);
  assert.deepEqual(revokedAssets, ["paste-web.png"], "the BYOK delete seam must revoke the registered live URL");
  await assert.rejects(() => host.adapter().deleteAsset("paste-source.pdf"), /image extension/);
  await assert.rejects(() => host.adapter().deleteAsset("figure.png"), /pasted image assets/);
  await host.dispose();
}
console.log("ok IndexedDB parentless nodes: standalone notes and away asks persist with null graph parents");

async function verifyFreshDatabaseInitialization() {
  const store = new IdbStore({ dbName: `rabbithole-indexeddb-initialization-${Date.now()}` });
  assert.deepEqual(await store.listHoles(), [], "a fresh browser database should start empty");
  const db = await store.open();
  const tx = db.transaction(["holes", "hole-summaries", "assets", "staging", "meta"], "readonly");
  const counts = await Promise.all(["holes", "hole-summaries", "assets", "staging", "meta"].map((name) => requestResult(tx.objectStore(name).count())));
  assert.deepEqual(counts, [0, 0, 0, 0, 0], "all current browser stores should be initialized empty");
  store.close();
  console.log("ok IndexedDB initializes the complete current browser store");
}

async function verifyPersistencePermissionDoesNotBlockWrites() {
  let persistCalls = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        persist: () => {
          persistCalls += 1;
          return new Promise(() => {});
        },
      },
    },
  });

  const dbName = `rabbithole-indexeddb-persist-${Date.now()}`;
  const persistenceStore = new IdbStore({ dbName });
  const hole = createPendingHoleFromQuestion("Why must optional persistence never block a write?");
  await Promise.race([
    persistenceStore.saveHole(hole),
    new Promise((_, reject) => setTimeout(() => reject(new Error("saveHole waited for persistent-storage permission")), 1_000)),
  ]);
  assert.equal(persistCalls, 1, "persistent-storage permission should be requested once");
  assert.equal((await persistenceStore.loadHole(hole.hole_id))?.hole_id, hole.hole_id, "the document should be saved while permission remains pending");
  persistenceStore.close();
  assert.equal((await persistenceStore.loadHole(hole.hole_id))?.hole_id, hole.hole_id, "the store should reopen after releasing its connection");
  persistenceStore.close();
  console.log("ok pending persistent-storage permission does not block IndexedDB writes");
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawHole(mode, value) {
  const db = await store.open();
  const tx = db.transaction("holes", mode);
  const request = mode === "readonly" ? tx.objectStore("holes").get(value) : tx.objectStore("holes").put(structuredClone(value));
  const result = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  return mode === "readonly" && result ? structuredClone(result) : result;
}

console.log("IndexedDB store contract verification passed");
