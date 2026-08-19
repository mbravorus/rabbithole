export class BridgeError extends Error {
  constructor(message, code = "turn_failed", statusCode) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.statusCode = statusCode ?? (code === "agent_missing" || code === "agent_signed_out" ? 503 : 400);
  }
}

export function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The request was cancelled");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

export function bridgeError(error) {
  if (error instanceof BridgeError) return error;
  return new BridgeError(error instanceof Error ? error.message : "The agent turn failed", "turn_failed", 500);
}

export function errorBody(error) {
  const normalized = bridgeError(error);
  return {
    statusCode: normalized.statusCode,
    body: {
      error: {
        message: normalized.message,
        code: normalized.code,
      },
    },
  };
}
