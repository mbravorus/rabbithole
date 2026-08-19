import { shouldReduceMotion } from "./core.js";

// The reader is the current card, maximized — but the transition never claims
// the two are the same picture. A geometric morph (scaling the reader down
// onto the card's rect) demands pixel equality between two different
// renderings at the handoff frame, and every miss reads as a jag. So the
// flight makes a smaller, unbreakable claim: the reader is a sheet that lifts
// off from the card's location and settles back toward it — a uniform ~3.5%
// zoom plus fade, anchored at the card's on-screen center (the macOS idiom:
// Dock, Quick Look, Spotlight). One element, one animation, one clock, and
// opacity is exactly 0 at every display flip, so no frame can contain a jump.
//
// The mode classes flip synchronously before a flight starts; the animation is
// purely decorative and interruptible. `mode-flight` on <body> keeps both
// surfaces displayed for the duration, and `.reader-flying` makes the sheet
// inert while it moves.
var ENTER_MS = 200;
var EXIT_MS = 160;
var FLIGHT_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
var LIFT_SCALE = 0.965;
var activeFlight = null;

function endFlight(flight){
  if (activeFlight !== flight) return;
  activeFlight = null;
  document.body.classList.remove("mode-flight");
  flight.el.classList.remove("reader-flying");
  flight.el.style.transformOrigin = "";
  // Landed: anything that measures the reader's on-screen geometry (the PDF
  // toolbar centers itself this way) can now trust getBoundingClientRect.
  document.dispatchEvent(new CustomEvent("rh-reader-flight-end"));
}

function cancelReaderFlight(){
  var flight = activeFlight;
  if (!flight) return;
  try { flight.animation.cancel(); } catch (e) { endFlight(flight); }
}

function rectCenter(rect){
  if (!rect || !rect.width || !rect.height) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function fly(origin, expanding){
  cancelReaderFlight();
  var el = document.getElementById("reader");
  if (!el) return false;
  if (typeof el.animate !== "function" || shouldReduceMotion() || document.hidden) return false;
  // Anchor the zoom at the card's center so the sheet reads as rising from
  // (or returning into) its card; a missing or off-screen card anchors at the
  // viewport center instead.
  var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  var ox = origin ? Math.max(0, Math.min(origin.x, vw)) : vw / 2;
  var oy = origin ? Math.max(0, Math.min(origin.y, vh)) : vh / 2;
  el.style.transformOrigin = ox + "px " + oy + "px";
  var lifted = { transform: "scale(" + LIFT_SCALE + ")", opacity: 0 };
  var seated = { transform: "none", opacity: 1 };
  document.body.classList.add("mode-flight");
  el.classList.add("reader-flying");
  var animation = el.animate(
    expanding ? [lifted, seated] : [seated, lifted],
    { duration: expanding ? ENTER_MS : EXIT_MS, easing: FLIGHT_EASE }
  );
  var flight = { el: el, animation: animation };
  activeFlight = flight;
  animation.onfinish = function(){ endFlight(flight); };
  animation.oncancel = function(){ endFlight(flight); };
  return true;
}

// Canvas → reader: the sheet rises out of the card it came from.
export function flyReaderFromRect(rect){ return fly(rectCenter(rect), true); }

// Reader → canvas: the sheet settles back toward the card it is.
export function flyReaderToRect(rect){ return fly(rectCenter(rect), false); }
