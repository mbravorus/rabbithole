import assert from "node:assert/strict";
import { BRANCH_FOLLOWUP, branchTypeOfNode, collectRelevantNotes } from "../../src/core/model.js";

const nodes = new Map([
  ["root", { id: "root", parent_id: null }],
  ["ancestor", { id: "ancestor", parent_id: "root" }],
  ["parent", { id: "parent", parent_id: "ancestor" }],
  ["sibling", { id: "sibling", parent_id: "root" }],
  ["standalone-late", { id: "standalone-late", parent_id: null, markdown: "Everywhere later", created_at: "2026-08-11T00:00:06.000Z", origin: { kind: "note" } }],
  ["root-note", { id: "root-note", parent_id: "root", markdown: "On root", created_at: "2026-08-11T00:00:05.000Z", origin: { kind: "note" } }],
  ["irrelevant", { id: "irrelevant", parent_id: "sibling", markdown: "Other branch", created_at: "2026-08-11T00:00:01.000Z", origin: { kind: "note", selected_text: "elsewhere" } }],
  ["standalone-early", { id: "standalone-early", parent_id: null, markdown: "Everywhere first", created_at: "2026-08-11T00:00:02.000Z", origin: { kind: "note" } }],
  ["parent-note", { id: "parent-note", parent_id: "parent", markdown: "On parent", created_at: "2026-08-11T00:00:04.000Z", origin: { kind: "note", selected_text: "focus" } }],
  ["ancestor-note", { id: "ancestor-note", parent_id: "ancestor", markdown: "On ancestor", created_at: "2026-08-11T00:00:03.000Z", origin: { kind: "note", selected_text: "clause" } }],
  ["lineage-note", { id: "lineage-note", parent_id: "ancestor", markdown: "Branch from me", created_at: "2026-08-11T00:00:07.000Z", origin: { kind: "note", selected_text: "note anchor" } }],
  ["on-lineage-note", { id: "on-lineage-note", parent_id: "lineage-note", markdown: "On the note", created_at: "2026-08-11T00:00:08.000Z", origin: { kind: "note", selected_text: "inside note" } }],
]);

assert.deepEqual(collectRelevantNotes(nodes, "parent"), [
  { note_id: "standalone-early", on_node_id: null, on_selected_text: null, content: "Everywhere first", created_at: "2026-08-11T00:00:02.000Z" },
  { note_id: "standalone-late", on_node_id: null, on_selected_text: null, content: "Everywhere later", created_at: "2026-08-11T00:00:06.000Z" },
  { note_id: "ancestor-note", on_node_id: "ancestor", on_selected_text: "clause", content: "On ancestor", created_at: "2026-08-11T00:00:03.000Z" },
  { note_id: "parent-note", on_node_id: "parent", on_selected_text: "focus", content: "On parent", created_at: "2026-08-11T00:00:04.000Z" },
  { note_id: "root-note", on_node_id: "root", on_selected_text: null, content: "On root", created_at: "2026-08-11T00:00:05.000Z" },
  { note_id: "lineage-note", on_node_id: "ancestor", on_selected_text: "note anchor", content: "Branch from me", created_at: "2026-08-11T00:00:07.000Z" },
]);

const fromNote = collectRelevantNotes(nodes, "lineage-note");
assert.deepEqual(fromNote.map((note) => note.note_id), [
  "standalone-early",
  "standalone-late",
  "ancestor-note",
  "root-note",
  "on-lineage-note",
]);
assert.equal(fromNote.some((note) => note.note_id === "lineage-note"), false, "a note already in the lineage must not be duplicated");
assert.equal(fromNote.some((note) => Object.hasOwn(note, "on_lineage")), false, "the default call must preserve the ambient-only entry shape");

const withLineage = collectRelevantNotes(nodes, "on-lineage-note", { includeLineage: true });
assert.deepEqual(withLineage.map((note) => note.note_id), [
  "lineage-note",
  "on-lineage-note",
  "standalone-early",
  "standalone-late",
  "ancestor-note",
  "root-note",
], "lineage notes are root-to-parent thread context before the existing ambient ordering");
assert.deepEqual(
  withLineage.filter((note) => Object.hasOwn(note, "on_lineage")).map((note) => [note.note_id, note.on_lineage]),
  [["lineage-note", true], ["on-lineage-note", true]],
  "only notes in the direct lineage carry on_lineage: true",
);
assert.equal(withLineage.slice(2).every((note) => !Object.hasOwn(note, "on_lineage")), true, "ambient entries omit the flag rather than setting it false");
assert.equal(branchTypeOfNode(nodes.get("root-note")), BRANCH_FOLLOWUP, "a parented note without an anchor belongs to the follow-up lane");

console.log("ok model notes: default exclusion plus includeLineage thread-first ordering and exact flag shape");
