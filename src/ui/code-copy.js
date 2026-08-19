// ===========================================================================
// CODE COPY
// ===========================================================================
// Every fenced code block in a document gets a quiet copy affordance: the pre
// is wrapped so the button can sit fixed in the corner while the code scrolls
// beneath it, and a successful copy answers with a brief green check.
import { iconSvg } from "../core/html/icons.js";

var COPIED_MS = 1800;

function copyWithTextarea(text){
  var previousFocus = document.activeElement;
  var ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch(err){}
  document.body.removeChild(ta);
  if (previousFocus && previousFocus.isConnected){
    try { previousFocus.focus(); } catch(err){}
  }
}

function copyText(text){
  if (navigator.clipboard && navigator.clipboard.writeText){
    return navigator.clipboard.writeText(text).catch(function(){ copyWithTextarea(text); });
  }
  copyWithTextarea(text);
  return Promise.resolve();
}

function setCopied(button, copied){
  var copyIcon = button.querySelector(".ic-copy");
  var checkIcon = button.querySelector(".ic-check");
  button.classList.toggle("copied", copied);
  button.setAttribute("aria-label", copied ? "Copied" : "Copy code");
  if (copyIcon) copyIcon.hidden = copied;
  if (checkIcon) checkIcon.hidden = !copied;
}

function onCopyClick(e){
  e.preventDefault();
  e.stopPropagation();
  var button = e.currentTarget;
  var code = button.parentElement && button.parentElement.querySelector("pre code");
  if (!code) return;
  copyText(code.textContent.replace(/\n$/, "")).then(function(){
    if (!button.isConnected) return;
    setCopied(button, true);
    clearTimeout(button._rhCopiedTimer);
    button._rhCopiedTimer = setTimeout(function(){
      setCopied(button, false);
    }, COPIED_MS);
  });
}

function stopBubble(e){ e.stopPropagation(); }

export function mountCodeCopy(root){
  if (!root) return;
  var pres = root.querySelectorAll("pre");
  for (var i = 0; i < pres.length; i++){
    var pre = pres[i];
    if (!pre.querySelector("code")) continue;
    if (pre.parentElement && pre.parentElement.classList.contains("code-block")) continue;
    var wrap = document.createElement("div");
    wrap.className = "code-block";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.setAttribute("aria-label", "Copy code");
    button.title = "Copy";
    button.innerHTML = '<span class="ic-copy">' + iconSvg("copy", { size: 14 }) + '</span>' +
      '<span class="ic-check" hidden>' + iconSvg("check", { size: 14 }) + '</span>';
    button.addEventListener("click", onCopyClick);
    button.addEventListener("dblclick", stopBubble);
    button.addEventListener("pointerdown", stopBubble);
    wrap.appendChild(button);
  }
}
