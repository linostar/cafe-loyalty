/** Replacement written in place of every redacted value. */
export const LOG_REDACT_CENSOR = "[redacted]";

/**
 * Header paths for pino's `redact` option, as a second line of defence for request objects
 * that a serializer passes through. Field-level redaction is done by `redactLogObject`.
 */
export const LOG_REDACT_HEADER_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
];

/** A key is sensitive when its letters and digits, lowercased, contain one of these. */
const SENSITIVE_SUBSTRINGS = [
  "phone",
  "email",
  "password",
  "passwd",
  "passphrase",
  "token",
  "secret",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "pepper",
  "privatekey",
];

/**
 * A key is also sensitive when one of its words (split on case changes and separators) is one of these.
 * They are matched as whole words because as substrings they occur inside harmless keys ("mapping", "footprint").
 * `detail` covers PostgreSQL errors, whose detail text repeats the conflicting values.
 */
const SENSITIVE_WORDS = new Set(["pin", "otp", "jwt", "detail"]);

const MAX_DEPTH = 10;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_SUBSTRINGS.some((fragment) => normalized.includes(fragment))) {
    return true;
  }
  const words = key.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).map((word) => word.toLowerCase());
  return words.some((word) => SENSITIVE_WORDS.has(word));
}

/**
 * Returns a copy of a log record with every sensitive key's value replaced by `LOG_REDACT_CENSOR`,
 * at any depth and inside arrays. Errors are serialized here (type, message, stack, own fields, cause)
 * so their extra fields are redacted too. Instances of other classes are passed through untouched for
 * pino's serializers (for example Fastify's request and reply), which must not emit sensitive fields.
 * Use as pino's `formatters.log`.
 */
export function redactLogObject(record: Record<string, unknown>): Record<string, unknown> {
  return redactEntries(record, 0, new WeakSet());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const copy = value.map((item: unknown) => redactValue(item, depth + 1, seen));
    seen.delete(value);
    return copy;
  }
  if (value instanceof Error) {
    seen.add(value);
    const serialized = serializeError(value, depth, seen);
    seen.delete(value);
    return serialized;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    return redactEntries(value as Record<string, unknown>, depth, seen);
  }
  return value;
}

function redactEntries(record: Record<string, unknown>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  seen.add(record);
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    copy[key] = isSensitiveKey(key) ? LOG_REDACT_CENSOR : redactValue(value, depth + 1, seen);
  }
  seen.delete(record);
  return copy;
}

function serializeError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    type: error.constructor.name,
    message: error.message,
    stack: error.stack,
  };
  for (const [key, value] of Object.entries(error)) {
    serialized[key] = isSensitiveKey(key) ? LOG_REDACT_CENSOR : redactValue(value, depth + 1, seen);
  }
  if (error.cause !== undefined) {
    serialized.cause = redactValue(error.cause, depth + 1, seen);
  }
  if (error instanceof AggregateError) {
    serialized.errors = redactValue(error.errors, depth + 1, seen);
  }
  return serialized;
}
