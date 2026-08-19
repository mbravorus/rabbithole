import assert from "node:assert/strict";
import { EDGE_BAND, EDGE_MAX_SPEED, createEdgeScroller, edgeVelocity } from "../../src/ui/edge-scroll.js";

const RECT = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };

// Well inside the viewport nothing arms, or every drag would drift the camera.
assert.deepEqual(edgeVelocity(500, 400, RECT), { x: 0, y: 0 });

// The inner lip of the band is the zero point, not a step onto full speed.
assert.equal(edgeVelocity(RECT.right - EDGE_BAND, 400, RECT).x, 0);
assert.equal(edgeVelocity(EDGE_BAND, 400, RECT).x, 0);

// Sign convention: positive x reveals what lies to the right.
assert.ok(edgeVelocity(990, 400, RECT).x > 0, "right edge reveals rightwards");
assert.ok(edgeVelocity(10, 400, RECT).x < 0, "left edge reveals leftwards");
assert.ok(edgeVelocity(500, 790, RECT).y > 0, "bottom edge reveals downwards");
assert.ok(edgeVelocity(500, 10, RECT).y < 0, "top edge reveals upwards");

// The ramp is monotonic — deeper into the band is never slower.
let previous = 0;
for (let inside = EDGE_BAND; inside >= 0; inside--) {
  const speed = edgeVelocity(RECT.right - inside, 400, RECT).x;
  assert.ok(speed >= previous, `speed must not fall off approaching the edge (inside=${inside})`);
  previous = speed;
}
assert.equal(previous, EDGE_MAX_SPEED, "the boundary itself runs at full speed");

// And the ramp is linear, not a curve: halfway into the band is half speed. A
// curve reads as the canvas running away from the hand near the edge.
assert.ok(
  Math.abs(edgeVelocity(RECT.right - EDGE_BAND / 2, 400, RECT).x - EDGE_MAX_SPEED / 2) < 1e-9,
  "the ramp is linear in depth",
);

// Past the edge the pointer has left the viewport; that pins, never overruns.
assert.equal(edgeVelocity(1200, 400, RECT).x, EDGE_MAX_SPEED);
assert.equal(edgeVelocity(-500, 400, RECT).x, -EDGE_MAX_SPEED);

// Both axes arm together, so a corner drag travels diagonally.
const corner = edgeVelocity(995, 795, RECT);
assert.ok(corner.x > 0 && corner.y > 0, "a corner scrolls on both axes");

// A viewport narrower than two bands must not arm both edges of one axis at
// once: the nearer edge wins, so the canvas never scrolls two ways.
const narrowWidth = EDGE_BAND + EDGE_BAND / 2;
const narrow = { left: 0, top: 0, right: narrowWidth, bottom: 800, width: narrowWidth, height: 800 };
assert.ok(edgeVelocity(narrowWidth / 4, 400, narrow).x < 0, "left half of a narrow viewport reveals leftwards");
assert.ok(edgeVelocity(narrowWidth * 0.75, 400, narrow).x > 0, "right half of a narrow viewport reveals rightwards");

// A collapsed viewport (hidden canvas, zero-size host) has no edges to arm.
assert.deepEqual(edgeVelocity(0, 0, { left: 0, top: 0, right: 0, bottom: 0 }), { x: 0, y: 0 });
assert.deepEqual(edgeVelocity(0, 0, null), { x: 0, y: 0 });

// ---- driver ----------------------------------------------------------------
// A hand-driven clock and rAF queue: the loop must pan while armed, coast to a
// stop when the pointer leaves the band, and never outlive an interrupted drag.
const frames = [];
let now = 0;
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
globalThis.performance = { now: () => now };

function runFrame(ms) {
  now += ms;
  const pending = frames.splice(0, frames.length);
  pending.forEach((fn) => fn && fn(now));
  return pending.filter(Boolean).length;
}

const pans = [];
const scroller = createEdgeScroller(() => RECT, (dx, dy) => pans.push([dx, dy]));

scroller.update(500, 400);
assert.equal(frames.length, 0, "a pointer away from the edges starts no loop");

scroller.update(1000, 400); // hard against the right edge: full speed
runFrame(16);
assert.equal(pans.length, 1);
// Revealing rightwards translates the camera left, by speed x elapsed seconds.
assert.ok(Math.abs(pans[0][0] - -EDGE_MAX_SPEED * 0.016) < 1e-9, `expected a one-frame pan, got ${pans[0][0]}`);
assert.ok(pans[0][1] === 0, "an unarmed axis contributes nothing");

// The loop keeps itself alive while armed, with no further pointer input.
runFrame(16);
assert.equal(pans.length, 2, "an armed scroll continues without pointermove");

// A long stall (backgrounded tab) is clamped, so the camera never teleports.
runFrame(5000);
assert.ok(Math.abs(pans[2][0]) <= EDGE_MAX_SPEED * 0.064 + 1e-9, "a stalled frame is clamped");

// Back inside: the loop stops rather than coasting on stale velocity.
scroller.update(500, 400);
const before = pans.length;
runFrame(16);
assert.equal(pans.length, before, "leaving the band stops the pan");
assert.equal(frames.length, 0, "and cancels the loop");

// An interrupted drag (pinch takeover, module dispose) must not leave it running.
scroller.update(1000, 400);
scroller.stop();
runFrame(16);
assert.equal(pans.length, before, "stop() ends the loop immediately");
assert.equal(frames.length, 0);

console.log("ok edge-scroll: ramp, sign, clamping, and loop teardown");
