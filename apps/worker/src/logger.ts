import { LOG_REDACT_CENSOR, LOG_REDACT_HEADER_PATHS, redactLogObject } from "@cafe-loyalty/shared";
import { pino, type DestinationStream, type Logger } from "pino";

/** Creates the worker's JSON logger with sensitive fields redacted at any depth. Writes to stdout unless a destination is given. */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    formatters: { log: redactLogObject },
    // Errors are already serialized and redacted by redactLogObject; pino's own err serializer would re-type them.
    serializers: { err: (value: unknown): unknown => value },
    redact: { paths: [...LOG_REDACT_HEADER_PATHS], censor: LOG_REDACT_CENSOR },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
