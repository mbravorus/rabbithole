const HEARTBEAT_MS = 15_000;

export function openEventStream(req, res, stateStore) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const emit = (state) => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    }
  };
  emit(stateStore.value);
  const unsubscribe = stateStore.subscribe(emit);
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(":heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.once("aborted", close);
  res.once("close", close);
}
