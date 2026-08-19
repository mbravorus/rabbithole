// Dragging a card toward the edge of the viewport scrolls the canvas under it,
// so a card can be carried past the edge of what is currently on screen instead
// of sliding out of sight. The gesture never moves the card by itself: it moves
// the camera and asks the caller to re-derive the card from the pointer, which
// keeps the card pinned under the cursor the whole way out.

// The band is measured in screen pixels, not world units, so the reach to the
// edge feels the same at every zoom level. It is deliberately thin: this arms
// when the pointer actually reaches the edge, not when it merely approaches.
export var EDGE_BAND = 16;
export var EDGE_MAX_SPEED = 400; // screen px per second, at the boundary and beyond
var MAX_STEP_MS = 64;            // a backgrounded tab must not teleport the camera

function ramp(inside){
  // Linear: 0 at the inner lip of the band, full speed at the boundary. Past the
  // boundary the pointer has left the viewport entirely, and that stays pinned.
  // A steady, readable crawl beats a curve that runs away under the hand.
  var t = Math.min(1, Math.max(0, (EDGE_BAND - inside) / EDGE_BAND));
  return EDGE_MAX_SPEED * t;
}

function axisVelocity(pos, lo, hi){
  // A viewport narrower than two bands would otherwise arm both edges at once;
  // the nearer edge wins, so the canvas never scrolls two ways along one axis.
  var near = pos - lo, far = hi - pos;
  if (near < EDGE_BAND && near <= far) return -ramp(near);
  if (far < EDGE_BAND) return ramp(far);
  return 0;
}

// Positive means "reveal content further along this axis": positive x reveals
// what lies to the right, which the camera does by translating left.
export function edgeVelocity(x, y, rect){
  if (!rect || rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return { x: 0, y: 0 };
  return { x: axisVelocity(x, rect.left, rect.right), y: axisVelocity(y, rect.top, rect.bottom) };
}

// getRect: the visible canvas area in client coordinates.
// panBy(dx, dy): translate the camera by this many screen pixels and re-derive
// whatever the pointer is dragging.
export function createEdgeScroller(getRect, panBy){
  var raf = 0, last = 0, vx = 0, vy = 0;

  function tick(now){
    raf = 0;
    var dt = Math.min(MAX_STEP_MS, now - last) / 1000;
    last = now;
    if (dt > 0 && (vx || vy)) panBy(-vx * dt, -vy * dt);
    if (vx || vy) raf = requestAnimationFrame(tick);
  }

  function stop(){
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    vx = vy = 0;
  }

  return {
    update: function(clientX, clientY){
      var v = edgeVelocity(clientX, clientY, getRect());
      vx = v.x; vy = v.y;
      if (!vx && !vy){ stop(); return; }
      if (!raf){ last = performance.now(); raf = requestAnimationFrame(tick); }
    },
    stop: stop
  };
}
