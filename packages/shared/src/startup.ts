import { EnvError } from "./env.js";
import { redactLogObject } from "./logging.js";

/**
 * Formats a failure that happens before the logger exists (for example invalid configuration)
 * as one JSON log line, so it reaches the same log pipeline as everything else.
 * Configuration errors list variable names only; other errors are serialized with redaction.
 */
export function formatStartupFailure(error: unknown, service: string, now: Date = new Date()): string {
  const base = { level: "fatal", time: now.toISOString(), service };
  if (error instanceof EnvError) {
    return JSON.stringify({ ...base, msg: "invalid configuration", issues: error.issues });
  }
  return JSON.stringify({ ...base, ...redactLogObject({ err: error }), msg: "startup failed" });
}
