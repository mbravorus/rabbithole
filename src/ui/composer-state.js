import { followupCommitFromEnter, isComposingText } from "./input-intent.js";

const LENS_KEYS = { "1": "explain", "2": "eli5", "3": "example", "4": "deeper" };

/**
 * @param {{ text: HTMLTextAreaElement, commits: Iterable<HTMLButtonElement>, lenses?: Iterable<HTMLButtonElement>, wrap: Element, hasDraft?: boolean | (() => boolean) }} elements
 * @param {{ phase: "frozen" | "closed" | "away" | "live", pending: boolean, disabled?: boolean }} state
 * @param {{ frozen: string, closed: string, pending: string, away: string, live: string }} copy
 */
export function applyComposerState(elements, state, copy) {
  // Must be a real boolean: an undefined tail would make classList.toggle
  // flip the class on every call instead of setting it.
  var down = !!(state.phase === "frozen" || state.phase === "closed" || state.pending);
  var commitsDown = down || !!state.disabled;
  var hasDraft = typeof elements.hasDraft === "function" ? elements.hasDraft() :
    (typeof elements.hasDraft === "boolean" ? elements.hasDraft : !!elements.text.value.trim());
  elements.text.disabled = down;
  elements.wrap.classList.toggle("disabled", down);
  var placeholderPhase = state.pending && state.phase !== "frozen" && state.phase !== "closed"
    ? "pending" : state.phase;
  elements.text.placeholder = copy[placeholderPhase];
  for (const commit of elements.commits) commit.disabled = commitsDown || !hasDraft;
  for (const lens of elements.lenses || []) lens.disabled = down;
}

// The one interaction contract for every composer surface: commit buttons and
// each surface's configured Enter gestures act on a draft, while lenses
// (buttons or 1–4 keys) act on an empty box only. Callbacks receive the raw event; sources and submit guards stay
// with the mount, as does listener lifetime — pass the mount's scope.listen
// when the surface outlives its module (raw addEventListener otherwise).
/** @param {{ text: HTMLTextAreaElement, actions: Element,
 *   listen?: (target: EventTarget, type: string, handler: (event: any) => void) => void,
 *   hasDraft?: () => boolean,
 *   commitFromEnter?: (event: KeyboardEvent) => string | null,
 *   onCommit: (kind: string, event: Event) => void,
 *   onLens: (lens: string, event: Event) => void }} surface */
export function wireComposerActions(surface) {
  var listen = surface.listen || function (target, type, handler) { target.addEventListener(type, handler); };
  var hasDraft = surface.hasDraft || function(){ return !!surface.text.value.trim(); };
  var commitFromEnter = surface.commitFromEnter || followupCommitFromEnter;
  var hasLenses = !!surface.actions.querySelector(".lens");
  listen(surface.actions, "click", function (e) {
    var target = /** @type {Element} */ (e.target);
    var button = target.closest ? /** @type {HTMLButtonElement | null} */ (target.closest("button")) : null;
    if (!button || button.disabled) return;
    if (button.dataset.commit && hasDraft()) surface.onCommit(button.dataset.commit, e);
    else if (button.dataset.lens && surface.text.value === "") surface.onLens(button.dataset.lens, e);
  });
  listen(surface.text, "keydown", function (e) {
    var commit = commitFromEnter(e);
    if (commit) { e.preventDefault(); surface.onCommit(commit, e); return; }
    // ⌘S/Ctrl+S saves the draft wherever the bar offers a Note action. The
    // browser's save dialog must never open over a focused composer, so the
    // key is swallowed even on surfaces that have nothing to save.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "s") {
      e.preventDefault();
      var note = surface.actions.querySelector('[data-commit="note"]');
      if (note && note.isConnected && hasDraft()) surface.onCommit("note", e);
      return;
    }
    if (hasLenses && !isComposingText(e) && surface.text.value === "" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && LENS_KEYS[e.key]) {
      e.preventDefault();
      surface.onLens(LENS_KEYS[e.key], e);
    }
  });
}
