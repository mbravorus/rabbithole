/*
 * Extracted from the former canvas.js monolith. Keep this string as the exact
 * self-contained browser payload; behavior is verified by the inline-script
 * node --check gate.
 */
export const CANVAS_SHELL = `
<div id="reader">
  <div id="reader-top">
    <div id="breadcrumb"></div>
    <button class="activity" id="act-reader" title="Jump to it" aria-label="Jump to active answer"></button>
    <button class="tool-btn" id="r-textdown" title="Smaller text">A−</button>
    <button class="tool-btn" id="r-textup" title="Larger text">A+</button>
    <button class="tool-btn" id="r-canvas" title="Open the spatial canvas">⤢ Canvas</button>
    <button class="tool-btn" id="r-share" title="Share, export, synthesize">↗ Share</button>
    <button class="tool-btn" id="r-theme" title="Toggle theme" aria-label="Toggle theme">◑</button>
    <button class="tool-btn" id="r-done" title="End the session (the hole stays saved)">Done</button>
  </div>
  <div id="since"><span class="since-dot"></span><span class="since-msg" id="since-msg"></span><button class="tool-btn" id="since-show">Show me</button><button id="since-x" title="Dismiss" aria-label="Dismiss activity notice">×</button></div>
  <div id="reader-cols">
    <div id="reader-center">
      <div id="reader-main"></div>
      <div id="composer">
        <div class="composer-inner" id="composer-inner">
          <textarea id="composer-text" rows="1" placeholder="Ask a follow-up about this document…"></textarea>
          <button id="composer-send" class="send-btn" title="Send (↵)" aria-label="Send follow-up" disabled><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12.8V3.6M8 3.6 3.9 7.7M8 3.6l4.1 4.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
      </div>
    </div>
    <div id="reader-side"></div>
  </div>
</div>

<div id="viewport"><div id="world"><svg id="edges"></svg></div></div>
<div id="toolbar">
  <button class="tool-btn tool-icon" id="t-rail" title="Toggle rabbitholes · S" aria-label="Toggle rabbitholes" aria-expanded="false" aria-controls="web-rail"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><rect x="2.5" y="2.75" width="11" height="10.5" rx="1.6"/><path d="M6.25 2.75v10.5"/></svg></button>
  <button class="tool-btn tool-icon" id="t-new" title="New Rabbithole · N" aria-label="New Rabbithole"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M8 3.25v9.5"/><path d="M3.25 8h9.5"/></svg></button>
  <span class="sep" id="app-sep"></span>
  <button class="tool-btn" id="t-reader" title="Back to reading"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M3.75 3.25h4.5c1 0 1.8.8 1.8 1.8v7.7H5.15c-.77 0-1.4-.63-1.4-1.4z"/><path d="M5.15 12.75c-.77 0-1.4-.63-1.4-1.4s.63-1.4 1.4-1.4h4.9"/></svg>Reader</button>
  <span class="sep"></span>
  <button class="tool-btn tool-icon" id="t-zout" title="Zoom out" aria-label="Zoom out">−</button>
  <button class="tool-btn" id="zoom-label" title="Zoom to 100%" aria-label="Zoom to 100%">100%</button>
  <button class="tool-btn tool-icon" id="t-zin" title="Zoom in" aria-label="Zoom in">+</button>
  <button class="tool-btn tool-icon" id="t-frame" title="Frame everything · F" aria-label="Frame everything · F"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M5.8 3.25H3.25V5.8"/><path d="M10.2 3.25h2.55V5.8"/><path d="M12.75 10.2v2.55H10.2"/><path d="M5.8 12.75H3.25V10.2"/></svg></button>
  <span class="sep"></span>
  <button class="tool-btn tool-icon" id="t-tidy" title="Tidy up layout · T" aria-label="Tidy up layout · T"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><rect x="6.25" y="2.5" width="3.5" height="2.75" rx="0.7"/><rect x="2.75" y="10.75" width="3.5" height="2.75" rx="0.7"/><rect x="9.75" y="10.75" width="3.5" height="2.75" rx="0.7"/><path d="M8 5.25v2.25"/><path d="M4.5 7.5h7"/><path d="M4.5 7.5v3.25"/><path d="M11.5 7.5v3.25"/></svg></button>
  <span class="sep"></span>
  <button class="tool-btn tool-icon" id="t-share" title="Share, export, synthesize" aria-label="Share, export, synthesize">↗</button>
  <button class="tool-btn tool-icon" id="t-theme" title="Toggle theme" aria-label="Toggle theme">◑</button>
  <button class="tool-btn tool-icon" id="t-settings" title="Provider settings" aria-label="Provider settings" aria-controls="web-settings-modal" aria-expanded="false"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M6.75 2.25h2.5l.38 1.55c.38.13.74.28 1.07.47l1.35-.82 1.25 2.16-1.18 1.03c.04.22.06.45.06.68s-.02.46-.06.68l1.18 1.03-1.25 2.16-1.35-.82c-.33.19-.69.34-1.07.47l-.38 1.55h-2.5l-.38-1.55a5.1 5.1 0 0 1-1.07-.47l-1.35.82-1.25-2.16 1.18-1.03a3.9 3.9 0 0 1 0-1.36L2.75 5.61 4 3.45l1.35.82c.33-.19.69-.34 1.07-.47z"/><circle cx="8" cy="8" r="1.9"/></svg></button>
  <span class="sep" id="act-sep" style="display:none"></span>
  <button class="activity" id="act-canvas" title="Jump to it" aria-label="Jump to active answer"></button>
</div>

<div id="ask">
  <div class="ask-input">
    <textarea id="ask-text" rows="1" placeholder="Ask about this… ↵ = Explain"></textarea>
    <button class="copy-btn" id="ask-copy" type="button" title="Copy selected text" aria-label="Copy selected text"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 10.5v-6A1.5 1.5 0 0 1 5 3h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
    <button class="send-btn" id="ask-go" title="Ask (↵)" aria-label="Ask"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12.8V3.6M8 3.6 3.9 7.7M8 3.6l4.1 4.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>
  <div class="ask-lenses" id="ask-lenses">
    <button class="lens" data-lens="explain">Explain <kbd>1</kbd></button>
    <button class="lens" data-lens="eli5">ELI5 <kbd>2</kbd></button>
    <button class="lens" data-lens="example">Example <kbd>3</kbd></button>
    <button class="lens" data-lens="deeper">Go Deeper <kbd>4</kbd></button>
  </div>
</div>

<div id="palette"><div id="palette-panel">
  <div class="pal-input">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    <input id="pal-text" placeholder="Search this Rabbithole…" autocomplete="off" spellcheck="false">
    <kbd>esc</kbd>
  </div>
  <div id="pal-results"></div>
</div></div>

<div id="peek"></div>

<div id="sharemenu">
  <button class="sm-item" id="sm-trail"><span class="sm-ic">⤷</span>Copy trail as Markdown</button>
  <button class="sm-item" id="sm-doc"><span class="sm-ic">⧉</span>Copy document as Markdown</button>
  <div class="sm-sep"></div>
  <button class="sm-item" id="sm-export"><span class="sm-ic">⇩</span>Download snapshot (.html)</button>
  <button class="sm-item" id="sm-portable"><span class="sm-ic">⇣</span>Export Rabbithole (.rabbithole)</button>
  <div class="sm-sep" id="sm-sep2"></div>
  <button class="sm-item" id="sm-synth"><span class="sm-ic">✦</span>Synthesize this journey</button>
</div>

<div id="confirm">
  <div class="cf-msg" id="cf-msg"></div>
  <div class="cf-row"><button id="cf-keep">Keep</button><button class="cf-remove" id="cf-remove">Remove</button></div>
</div>

<div id="banner"><div class="banner-body"><span class="banner-title" id="banner-title"></span><span id="banner-msg"></span></div><button id="banner-x" title="Dismiss" aria-label="Dismiss banner">×</button></div>
<div id="hint"></div>
`;
