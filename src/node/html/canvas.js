/**
 * Self-contained page for a Rabbithole.
 *
 * The frontend is authored as three focused strings (styles, shell, browser
 * runtime) and assembled here into one HTML document. The output is still a
 * single-file page for live sessions and frozen exports.
 */

import { escapeHtml, serializeForInlineScript } from "../../core/utils.js";
import { getDompurifyScript, getMermaidScript, getPdfJsScript, getPdfWorkerScript, getUiAssets } from "./built-assets.js";
import { getCoreHtml } from "./dev-reload.js";

export async function buildCanvasHtml(hydration) {
  const title = hydration?.title || "Rabbithole";
  const hydrationJson = serializeForInlineScript(hydration);
  const { stylesheetText, clientSource, frozenClientSource } = await getUiAssets();
  const { CANVAS_SHELL } = await getCoreHtml();
  const liveSnapshotSource = `  window.__RABBITHOLE_FROZEN_CLIENT__ = ${serializeForInlineScript(frozenClientSource)};\n`;
  const liveSnapshotHoleHook = `      getSnapshotHole: async function(){
        var response = await fetch("/snapshot-hole", { cache: "no-store" });
        if (!response.ok) throw new Error("Snapshot document is unavailable");
        return response.json();
      },\n`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${stylesheetText}
</style>
</head>
<body>
${CANVAS_SHELL}
<script type="application/vnd.rabbithole+mermaid" id="rabbithole-mermaid-runtime">${getMermaidScript()}</script>
<script type="application/vnd.rabbithole+pdfjs" id="rabbithole-pdfjs-runtime">${getPdfJsScript().replace(/<\/script/gi, "<\\/script")}</script>
<script type="application/vnd.rabbithole+pdf-worker" id="rabbithole-pdf-worker-runtime">${getPdfWorkerScript().replace(/<\/script/gi, "<\\/script")}</script>
<script>
${getDompurifyScript()}
(function(){
	  "use strict";
	  var hydration = ${hydrationJson};
	${liveSnapshotSource}${clientSource}
	  RabbitholeClient.startRabbithole(hydration, {
	    snapshotHooks: {
	${liveSnapshotHoleHook}      getFrozenClientSource: function(){ return window.__RABBITHOLE_FROZEN_CLIENT__ || ""; },
	      getStylesheetText: function(){
	        var style = document.head && document.head.querySelector("style:first-of-type");
	        return style ? style.textContent : "";
	      }
	    }
	  });
	})();
</script>
</body>
</html>`;
}
