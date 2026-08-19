import { disposeCore, initCore, nodes, registerCoreHooks } from "./core.js";
import { disposeVisuals, registerVisualHooks } from "./visuals.js";
import { disposeImageUx, mountDocImages } from "./image-ux.js";
import { disposeReader, initReader, openNode, registerReaderHooks } from "./reader.js";
import {
  closeCardMenu,
  disposeCanvasView,
  initCanvasView,
  registerCanvasHooks,
  scheduleEdges,
  setMode
} from "./canvas-view.js";
import {
  animateScroll,
  disposeAskFollowups,
  hideAsk,
  initAskFollowups,
  rollbackBranch,
  sendFollowup,
  updateComposerState
} from "./ask-followups.js";
import {
  closeDockedNotePopover,
  createDockedNote,
  createPlacedNote,
  disposeDockedNotes,
  initDockedNotes,
  positionDockedNotes,
  renderDockedNotes,
  revealDockedNote
} from "./docked-notes.js";
import { disposePalette, initPalette, registerPaletteHooks } from "./palette.js";
import {
  closeShare,
  commitPendingBranchRemoval,
  copyNodeMarkdown,
  disposeBranchSurfaces,
  initBranchSurfaces,
  removeBranch,
  registerBranchHooks
} from "./branch-surfaces.js";
import { disposeChrome, initChrome } from "./chrome-init.js";
import { closeSettingsSheet, initSettingsSheet } from "./settings-sheet.js";
import { ensureNodeHtml, setRendererAssetData } from "./renderer.js";

var activeRuntime = null;

function noop() {}
function resolved() { return Promise.resolve({ ok: true }); }

export function createRabbitholeUi({ hydration, host, capabilities } = {}) {
  if (activeRuntime && !activeRuntime.disposed) {
    throw new Error("Dispose the active Rabbithole UI before starting another one");
  }

  host = host || {};
  capabilities = capabilities || {};
  var post = typeof host.post === "function" ? host.post : resolved;
  var putAsset = typeof host.putAsset === "function" ? host.putAsset : resolved;
  var deleteAsset = typeof host.deleteAsset === "function" ? host.deleteAsset : resolved;
  var cleanups = [];
  var disposed = false;

  function own(cleanup) {
    cleanups.push(cleanup);
  }

  try {
    var visualRuntimeHooks = { post: post, getNode: function(id){ return nodes[id] || null; } };
    if (typeof capabilities.loadMermaid === "function") visualRuntimeHooks.loadMermaid = capabilities.loadMermaid;
    registerVisualHooks(visualRuntimeHooks);
    initCore(hydration);
    own(disposeCore);
    own(function(){ setRendererAssetData(null); });
    own(disposeVisuals);
    own(disposeImageUx);
    var mountImages = function(dc, surfaceKey) {
      mountDocImages(dc, surfaceKey, { hideAsk: hideAsk, scheduleEdges: scheduleEdges });
    };

    registerCoreHooks({
      post: post,
      putAsset: putAsset,
      deleteAsset: deleteAsset,
      openNode: openNode,
      ensureNodeHtml: ensureNodeHtml,
      persistNode: host.persistNode || noop,
      revealDockedNote: revealDockedNote,
      mountDocImages: mountImages,
      mountPdfView: capabilities.mountPdfView || null
    });
    registerReaderHooks({
      hideAsk: hideAsk,
      updateComposerState: updateComposerState,
      scheduleViewSave: host.scheduleViewSave || noop,
      setMode: setMode,
      mountDocImages: mountImages,
      animateScroll: animateScroll,
      renderDockedNotes: renderDockedNotes
    });
    registerCanvasHooks({
      hideAsk: hideAsk,
      sendFollowup: sendFollowup,
      sendNote: createDockedNote,
      sendPlacedNote: createPlacedNote,
      renderDockedNotes: renderDockedNotes,
      positionDockedNotes: positionDockedNotes,
      closeDockedNotePopover: closeDockedNotePopover,
      rollbackBranch: rollbackBranch,
      copyNodeMarkdown: copyNodeMarkdown,
      removeBranch: removeBranch,
      persistNode: host.persistNode || noop,
      persistNodesBulk: host.persistNodesBulk || noop,
      scheduleViewSave: host.scheduleViewSave || noop
    });
    registerPaletteHooks({
      hideAsk: hideAsk,
      closeShare: closeShare,
      closeCardMenu: closeCardMenu
    });
    registerBranchHooks({
      exportSnapshot: capabilities.exportSnapshot || null,
      exportPortable: capabilities.exportPortable || null
    });

    /* The gear lives in the shared taskbar, which outlives any one hole: the
       sheet binds once per host and every hole simply re-confirms it. Sections
       are data — a host that registers none still gets Appearance. */
    initSettingsSheet({ hostLabel: capabilities.settingsHostLabel });
    own(function(){ closeSettingsSheet({ restoreFocus: false }); });

    initReader(); own(disposeReader);
    initCanvasView(); own(disposeCanvasView);
    // After the reader and the canvas, so a docked note's own click handling
    // sees the event once its surfaces have declined it.
    initDockedNotes(); own(disposeDockedNotes);
    initAskFollowups(); own(disposeAskFollowups);
    initPalette(); own(disposePalette);
    initBranchSurfaces(); own(disposeBranchSurfaces);
    if (typeof host.start === "function") host.start();
    initChrome({
      connectSse: host.connect || null,
      post: post,
      refreshStatus: host.refreshStatus || noop
    });
    own(disposeChrome);
  } catch (error) {
    disposeOwned();
    throw error;
  }

  var runtime = {
    get disposed(){ return disposed; },
    flush: function(){
      return typeof host.flush === "function" ? Promise.resolve(host.flush()) : Promise.resolve();
    },
    dispose: async function(){
      if (disposed) return;
      disposed = true;
      if (activeRuntime === runtime) activeRuntime = null;
      var errors = [];
      try { await commitPendingBranchRemoval(); } catch (error) { errors.push(error); }
      if (typeof host.dispose === "function") {
        try { await host.dispose(); } catch (error) { errors.push(error); }
      }
      try { disposeOwned(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Rabbithole UI disposal failed");
    }
  };
  activeRuntime = runtime;
  return runtime;

  function disposeOwned() {
    var errors = [];
    while (cleanups.length) {
      try { cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Rabbithole UI cleanup failed");
  }
}
