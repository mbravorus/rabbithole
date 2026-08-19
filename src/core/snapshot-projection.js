import { getAssetContentType } from "./assets.js";
import { createPortableProjection } from "./portable-projection.js";

/** @typedef {import("./contracts/artifact.js").PersistedHole} PersistedHole */
/** @typedef {import("./contracts/artifact.js").PortableArtifact} PortableArtifact */

/**
 * @param {PersistedHole} hole
 * @param {PersistedHole["view_state"]} viewState
 * @param {Record<string, string>} assets
 * @returns {PortableArtifact}
 */
export function createSnapshotProjection(hole, viewState, assets) {
  const projection = createPortableProjection({ ...hole, view_state: viewState }, assets);
  // Shares exclude personal extension state. Native PDF provenance is document
  // content, not a preference, and is required to render the embedded source;
  // a note's docked flag is likewise how that note is shaped on the page, so a
  // snapshot that dropped it would strand the note as a card with no place.
  projection.hole = {
    ...projection.hole,
    nodes: projection.hole.nodes.map((node) => ({
      ...node,
      extensions: {
        ...(node.extensions?.pdf ? { pdf: node.extensions.pdf } : {}),
        ...(node.extensions?.note ? { note: node.extensions.note } : {}),
      },
    })),
  };
  return projection;
}

/** @param {PortableArtifact} projection */
export function snapshotProjectionToFrozenHydration(projection) {
  const hole = projection.hole;
  /** @type {Record<string, string>} */
  const assetData = {};
  for (const [name, encoded] of Object.entries(projection.assets)) {
    assetData[name] = `data:${getAssetContentType(name)};base64,${encoded}`;
  }
  return {
    title: hole.title,
    root_id: hole.root_id,
    last_event_id: 0,
    agent_attached: false,
    view_state: hole.view_state,
    frozen: true,
    asset_data: assetData,
    nodes: hole.nodes,
  };
}
