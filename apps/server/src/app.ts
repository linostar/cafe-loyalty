import { LOG_REDACT_CENSOR, LOG_REDACT_HEADER_PATHS, redactLogObject } from "@cafe-loyalty/shared";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

export interface AppOptions {
  logLevel: string;
  /** Log destination; defaults to stdout. Tests pass a capturing stream. */
  logDestination?: { write(chunk: string): void };
}

/** A path segment that looks like a random secret (at least 16 URL-safe characters). */
const SECRET_LIKE_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

/**
 * The path to log for a request: the matched route pattern (for example `/card/:secret`), never the raw URL,
 * because card and recovery links carry secrets in the path or query. For unmatched requests the query is
 * dropped and secret-looking segments are masked.
 */
export function loggablePath(request: Pick<FastifyRequest, "url" | "routeOptions">): string {
  const route = request.routeOptions.url;
  if (route !== undefined) {
    return route;
  }
  const path = request.url.split("?", 1)[0] ?? "";
  return path
    .split("/")
    .map((segment) => (SECRET_LIKE_SEGMENT.test(segment) ? LOG_REDACT_CENSOR : segment))
    .join("/");
}

interface SerializedError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
}

/**
 * Error serializer for Fastify's logger. `redactLogObject` has normally serialized and redacted the error already;
 * an Error that reaches this point unserialized is redacted here, so no path logs an error unredacted.
 */
function serializeError(value: unknown): SerializedError {
  const record = (value instanceof Error ? redactLogObject({ err: value }).err : value) as Record<string, unknown>;
  return {
    ...record,
    type: typeof record.type === "string" ? record.type : "Error",
    message: typeof record.message === "string" ? record.message : "",
    stack: typeof record.stack === "string" ? record.stack : "",
  };
}

function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    path: loggablePath(request),
    host: request.host,
    remoteAddress: request.ip,
  };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.logLevel,
      formatters: { log: redactLogObject },
      // pino's own err serializer would re-type errors that redactLogObject already serialized.
      serializers: { req: serializeRequest, err: serializeError },
      redact: { paths: [...LOG_REDACT_HEADER_PATHS], censor: LOG_REDACT_CENSOR },
      ...(options.logDestination === undefined ? {} : { stream: options.logDestination }),
    },
  });

  app.get("/health/live", () => ({ status: "ok" }));

  // Replaces Fastify's default handler, whose log message contains the raw URL (secrets included).
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ code: "NOT_FOUND", message: "No such page or API route.", retryable: false }),
  );

  return app;
}
