import { LOG_REDACT_CENSOR, LOG_REDACT_HEADER_PATHS, redactLogObject } from "@cafe-loyalty/shared";
import { pino, type Logger } from "pino";

/** JSON logger for the database command-line tools, with the same redaction as the server and worker. */
export function createCliLogger(level: string): Logger {
  return pino({
    level,
    formatters: { log: redactLogObject },
    // Errors are already serialized and redacted by redactLogObject; pino's own err serializer would re-type them.
    serializers: { err: (value: unknown): unknown => value },
    redact: { paths: [...LOG_REDACT_HEADER_PATHS], censor: LOG_REDACT_CENSOR },
  });
}
