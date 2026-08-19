import { childrenOf, nodes } from "./core.js";
import { isNoteNode } from "../core/model.js";

var MARK_FRAGMENT_SELECTOR = "mark[data-child], .rh-pdf-mark[data-child]";

function markGroupsAt(target){
  var el = target && target.nodeType === 1 ? target : target && target.parentElement;
  var groups = [];
  while (el){
    if (el.matches && el.matches(MARK_FRAGMENT_SELECTOR)){
      var root = el.closest(".doc-content");
      var childId = el.dataset.child;
      var seen = false;
      for (var i = 0; i < groups.length; i++){
        if (groups[i].root === root && groups[i].childId === childId){ seen = true; break; }
      }
      if (root && childId != null && !seen) groups.push({ root: root, childId: childId, fragment: el });
    }
    if (el.classList && el.classList.contains("doc-content")) break;
    el = el.parentElement;
  }
  return groups;
}

function sameMarkGroup(groups, group){
  for (var i = 0; i < groups.length; i++){
    if (groups[i].root === group.root && groups[i].childId === group.childId) return true;
  }
  return false;
}

function toggleMarkGroup(fragment, stateClass, on){
  if (!fragment || !fragment.matches || !fragment.matches(MARK_FRAGMENT_SELECTOR)) return;
  var root = fragment.closest(".doc-content"), childId = fragment.dataset.child;
  if (!root || childId == null) return;
  var marks = root.querySelectorAll(MARK_FRAGMENT_SELECTOR);
  for (var i = 0; i < marks.length; i++){
    if (marks[i].dataset.child === childId) marks[i].classList.toggle(stateClass, on);
  }
}

export function transitionMarkGroups(event, entering, stateClass, onTransition){
  var active = markGroupsAt(event.target);
  var related = markGroupsAt(event.relatedTarget);
  for (var i = 0; i < active.length; i++){
    var group = active[i];
    if (sameMarkGroup(related, group)) continue;
    toggleMarkGroup(group.fragment, stateClass, entering);
    if (onTransition) onTransition(group.childId, entering);
  }
}

export function applyChildHighlights(dc, node){
  if (dc && dc.classList.contains("rh-pdf")) return;
  var kids = childrenOf(node.id).filter(function(k){ return k.origin && k.origin.anchor; });
  kids.sort(function(a,b){ return b.origin.anchor.offset_start - a.origin.anchor.offset_start; });
  kids.forEach(function(k){
    var a = k.origin.anchor;
    var r = rangeFromOffsets(dc, a.offset_start, a.offset_end);
    if (!r) return;
    var note = isNoteNode(k);
    var cls = "hl " + (k.status === "answered" ? "mark-ready" : "mark-pending") + (note ? " mark-note" : "");
    if (note) overlayRange(r, k.id, cls);
    else wrapRange(r, k.id, cls);
  });
}

export function wrapInContainer(dc, anchor, childId, cls){
  if (!dc || !anchor || dc.classList.contains("rh-pdf") || anchor.pdf) return;
  var rr = rangeFromOffsets(dc, anchor.offset_start, anchor.offset_end);
  if (rr){
    try {
      if (/(^|\s)mark-note(\s|$)/.test(cls)) overlayRange(rr, childId, cls);
      else wrapRange(rr, childId, cls);
    } catch(e){}
  }
}

/* Re-measure note washes after a card/reader resize. The fragments are empty
   paint and hit-test boxes, so this pass cannot feed back into text layout. */
export function syncTextOverlayMarks(root){
  if (!root || !root.querySelectorAll) return;
  var containers = root.matches && root.matches(".doc-content") ? [root] : root.querySelectorAll(".doc-content");
  for (var c = 0; c < containers.length; c++){
    var dc = containers[c];
    var marks = dc.querySelectorAll("mark.mark-overlay[data-child]");
    var seen = {};
    for (var i = 0; i < marks.length; i++){
      var childId = marks[i].dataset.child;
      if (seen[childId]) continue;
      seen[childId] = true;
      var child = nodes[childId], anchor = child && child.origin && child.origin.anchor;
      if (!anchor || anchor.pdf) continue;
      var range = rangeFromOffsets(dc, anchor.offset_start, anchor.offset_end);
      if (!range) continue;
      overlayRange(range, childId, marks[i].className.replace(/\s*mark-overlay\b/, ""));
    }
  }
}

export function upgradeMarks(root, childId){
  if (!root) return;
  var marks = root.querySelectorAll('[data-child="' + childId + '"]');
  var child = nodes[childId], label = "Open branch: " + ((child && child.title) || "Untitled");
  for (var i = 0; i < marks.length; i++){
    marks[i].classList.remove("mark-pending"); marks[i].classList.add("mark-ready");
    marks[i].setAttribute("aria-label", label);
  }
}

export function setPendingMarks(root, childId){
  if (!root) return;
  var marks = root.querySelectorAll('[data-child="' + childId + '"]');
  for (var i = 0; i < marks.length; i++){
    marks[i].classList.remove("mark-ready", "mark-note");
    marks[i].classList.add("mark-pending");
  }
}

export function setNoteMarks(root, childId){
  if (!root) return;
  var marks = root.querySelectorAll('[data-child="' + childId + '"]');
  for (var i = 0; i < marks.length; i++){
    marks[i].classList.remove("mark-pending");
    marks[i].classList.add("mark-ready", "mark-note");
  }
}

export function removeMarks(root, childId){
  if (!root) return;
  var marks = root.querySelectorAll('[data-child="' + childId + '"]');
  for (var i = 0; i < marks.length; i++){
    var m = marks[i], p = m.parentNode; if (!p) continue;
    if (m.namespaceURI === "http://www.w3.org/2000/svg") { m.remove(); continue; }
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m); p.normalize();
  }
}

function rangeFromOffsets(container, startOff, endOff){
  var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  var pos = 0, sN, sO, eN, eO;
  while (walker.nextNode()){
    var node = walker.currentNode, L = node.textContent.length;
    if (sN == null && pos + L > startOff){ sN = node; sO = startOff - pos; }
    if (pos + L >= endOff){ eN = node; eO = endOff - pos; break; }
    pos += L;
  }
  if (sN == null || eN == null) return null;
  var r = document.createRange();
  try { r.setStart(sN, sO); r.setEnd(eN, eO); } catch(e){ return null; }
  return r;
}

export function charOffset(container, node, offset){
  var r = document.createRange();
  r.selectNodeContents(container);
  try { r.setEnd(node, offset); } catch(e){ return 0; }
  return r.toString().length;
}

function wrapTextNode(textNode, childId, cls){
  var m = document.createElement("mark");
  initializeMark(m, childId, cls);
  textNode.parentNode.insertBefore(m, textNode);
  m.appendChild(textNode);
}

function initializeMark(m, childId, cls){
  if (m.namespaceURI === "http://www.w3.org/2000/svg") m.setAttribute("class", cls);
  else m.className = cls;
  m.dataset.child = childId;
  m.setAttribute("tabindex", "0"); m.setAttribute("role", "link");
  var child = nodes[childId];
  m.setAttribute("aria-label", "Open branch: " + ((child && child.title) || "Untitled"));
  return m;
}

function overlayRange(range, childId, cls){
  var ancestor = range.commonAncestorContainer;
  var dc = (ancestor.nodeType === 1 ? ancestor : ancestor.parentElement).closest(".doc-content");
  if (!dc) return;
  var rects = Array.from(range.getClientRects()).filter(function(rect){ return rect.width > 0 && rect.height > 0; });
  var selector = 'mark.mark-overlay[data-child="' + childId + '"]';
  var marks = Array.from(dc.querySelectorAll(selector));
  var fragmentCount = Math.max(1, rects.length);
  while (marks.length < fragmentCount){
    var mark = document.createElement("mark");
    dc.appendChild(mark); marks.push(mark);
  }
  while (marks.length > fragmentCount) marks.pop().remove();
  for (var i = 0; i < marks.length; i++) initializeMark(marks[i], childId, cls + " mark-overlay");
  if (!rects.length){
    marks[0].style.width = "0"; marks[0].style.height = "0";
    return;
  }
  var offsetParent = marks[0].offsetParent;
  if (!offsetParent) return;
  var parentRect = offsetParent.getBoundingClientRect();
  var scaleX = offsetParent.offsetWidth ? parentRect.width / offsetParent.offsetWidth : 1;
  var scaleY = offsetParent.offsetHeight ? parentRect.height / offsetParent.offsetHeight : scaleX;
  if (!scaleX) scaleX = 1;
  if (!scaleY) scaleY = scaleX;
  for (var j = 0; j < marks.length; j++){
    var rect = rects[j], current = marks[j];
    current.style.left = ((rect.left - parentRect.left) / scaleX + offsetParent.scrollLeft) + "px";
    current.style.top = ((rect.top - parentRect.top) / scaleY + offsetParent.scrollTop) + "px";
    current.style.width = (rect.width / scaleX) + "px";
    current.style.height = (rect.height / scaleY) + "px";
  }
}

export function mountPdfRectMark(container, anchor, childId, cls) {
  if (!container || !anchor || !anchor.pdf) return null;
  var first = null, fragments = anchor.pdf.fragments || [];
  for (var f = 0; f < fragments.length; f++) {
    var fragment = fragments[f];
    var page = container.querySelector('.rh-pdf-page[data-page="' + Math.floor(Number(fragment.page)) + '"]');
    var viewport = page && page._pdfViewport;
    var layer = page && page.querySelector(".rh-pdf-marks");
    if (!layer || !viewport) continue;
    var group = initializeMark(document.createElementNS("http://www.w3.org/2000/svg", "g"), childId, cls);
    for (var q = 0; q < fragment.quads.length; q++) {
      var quad = fragment.quads[q], points = [];
      for (var p = 0; p < quad.length; p++) {
        var converted = viewport.convertToViewportPoint(Number(quad[p][0]), Number(quad[p][1]));
        points.push(converted[0] + "," + converted[1]);
      }
      var polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", points.join(" ")); group.appendChild(polygon);
    }
    layer.appendChild(group); if (!first) first = group;
  }
  return first;
}

function wrapRange(range, childId, cls){
  var startC = range.startContainer, endC = range.endContainer, startO = range.startOffset, endO = range.endOffset;
  if (startC === endC && startC.nodeType === 3){
    if (startO === endO) return;
    var mid = startC.splitText(startO); mid.splitText(endO - startO);
    wrapTextNode(mid, childId, cls); return;
  }
  var ancestor = range.commonAncestorContainer; if (ancestor.nodeType === 3) ancestor = ancestor.parentNode;
  var walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
  var collected = [], inRange = false;
  while (walker.nextNode()){
    var n = walker.currentNode;
    if (n === startC){ inRange = true; var info = { node:n, start:startO, end:n.textContent.length }; if (n === endC){ info.end = endO; collected.push(info); break; } collected.push(info); continue; }
    if (n === endC){ collected.push({ node:n, start:0, end:endO }); break; }
    if (inRange) collected.push({ node:n, start:0, end:n.textContent.length });
  }
  for (var i = collected.length - 1; i >= 0; i--){
    var c = collected[i], node = c.node, s = c.start, e = c.end, L = node.textContent.length;
    if (s >= e || !L) continue;
    var t = s > 0 ? node.splitText(s) : node;
    if (e < L) t.splitText(e - s);
    wrapTextNode(t, childId, cls);
  }
}
