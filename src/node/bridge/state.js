// Two polling cadences: a responsive one while any backend is not yet
// `ready` (installing, signing in, recovering from an error) and a slow one
// once every backend is ready and stable. Polling only runs while at least
// one listener (an open /bridge/events stream) is subscribed — an idle
// bridge with no browser attached does not probe the CLIs at all. Each probe
// of the Claude backend spawns a real `claude -p /model` call, i.e. an
// actual API round trip, so an unthrottled interval here means the bridge
// silently keeps invoking Claude on a fixed cadence for as long as it runs,
// whether or not anyone is using it.
const REFRESH_MS = 15_000;
const READY_REFRESH_MS = 3 * 60 * 1000;
const STATES = new Set(["starting", "missing", "signed_out", "ready", "error"]);

function assertAgentState(agent) {
  if (!agent || !STATES.has(agent.state)) {
    throw new Error(`Invalid bridge state for ${agent?.id || "unknown agent"}`);
  }
  const ready = agent.state === "ready";
  const hasModels = Array.isArray(agent.models) && agent.models.length > 0;
  if (ready !== hasModels) {
    throw new Error(`Bridge agent ${agent.id} violates ready/models invariant`);
  }
  if (ready || agent.state === "starting") {
    if (Object.hasOwn(agent, "fix")) {
      throw new Error(`${agent.state} bridge agent ${agent.id} must not carry a fix`);
    }
    if (!ready && Object.hasOwn(agent, "models")) {
      throw new Error(`Starting bridge agent ${agent.id} must not carry models`);
    }
  } else if (typeof agent.fix !== "string" || !agent.fix || Object.hasOwn(agent, "models")) {
    throw new Error(`Non-ready bridge agent ${agent.id} must carry exactly one fix and no models`);
  }
  return agent;
}

export function readyAgent(id, { plan, models }) {
  return assertAgentState({
    id,
    state: "ready",
    ...(plan ? { plan } : {}),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      images: model.images,
      reasoning: model.reasoning,
    })),
  });
}

export function startingAgent(id, detail) {
  return assertAgentState({
    id,
    state: "starting",
    ...(detail ? { detail } : {}),
  });
}

export function unavailableAgent(id, state, fix, detail) {
  return assertAgentState({
    id,
    state,
    fix,
    ...(detail ? { detail } : {}),
  });
}

export class BridgeStateStore {
  constructor({ version, backends, logger, refreshMs = REFRESH_MS, readyRefreshMs = READY_REFRESH_MS }) {
    this.version = version;
    this.backends = backends;
    this.logger = logger;
    this.refreshMs = refreshMs;
    this.readyRefreshMs = readyRefreshMs;
    this.listeners = new Set();
    this.timer = null;
    this.refreshPromise = null;
    this.closed = false;
    this.value = {
      bridge: version,
      agents: [
        backends.claude.initialState(),
        backends.codex.initialState(),
      ].map(assertAgentState),
    };
  }

  /** Slow way down once nothing is left to converge on. */
  nextRefreshMs() {
    const allReady = this.value.agents.every((agent) => agent.state === "ready");
    return allReady ? this.readyRefreshMs : this.refreshMs;
  }

  subscribe(listener) {
    const wasIdle = this.listeners.size === 0;
    this.listeners.add(listener);
    // A bridge nobody is watching does not need fresh state; resume polling
    // (with an immediate refresh, not a stale wait for the next tick) only
    // once someone actually subscribes.
    if (wasIdle && !this.refreshPromise) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = null;
    // No one is subscribed: stop polling entirely instead of ticking an
    // unattended bridge on a fixed interval. subscribe() resumes it.
    if (this.listeners.size === 0) return;
    this.timer = setTimeout(() => {
      void this.refresh();
    }, this.nextRefreshMs());
    this.timer.unref?.();
  }

  async refresh() {
    if (this.closed) return this.value;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = Promise.all([
      this.backends.claude.probe(),
      this.backends.codex.probe(),
    ]).then((agents) => {
      const next = {
        bridge: this.version,
        agents: agents.map(assertAgentState),
      };
      if (JSON.stringify(next) !== JSON.stringify(this.value)) {
        this.value = next;
        for (const listener of this.listeners) listener(next);
      }
      return this.value;
    }).catch((error) => {
      this.logger?.warn?.(`Bridge state refresh failed (${error?.code || "turn_failed"})`);
      return this.value;
    }).finally(() => {
      this.refreshPromise = null;
      this.schedule();
    });
    return this.refreshPromise;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
