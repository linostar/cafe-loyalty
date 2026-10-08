import { ApiError, ERROR_CODES, type ErrorCode } from "@cafe-loyalty/shared";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

/** Parses request input with a shared schema; a failure becomes VALIDATION_FAILED listing each field's problem. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new ApiError(
    "VALIDATION_FAILED",
    "Some fields are missing or not valid. Check them and try again.",
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), issue: issue.message })),
  );
}

/** A RATE_LIMITED error, with Retry-After set on the reply. */
export function rateLimited(reply: FastifyReply, retryAfterSeconds: number): ApiError {
  void reply.header("retry-after", String(retryAfterSeconds));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return new ApiError("RATE_LIMITED", `Too many attempts. Wait ${String(minutes)} minute${minutes === 1 ? "" : "s"} and try again.`);
}

/** Envelopes for errors Fastify raises itself (unparseable JSON, oversized bodies, unsupported content types). */
const FRAMEWORK_ERRORS: Readonly<Partial<Record<number, { code: ErrorCode; message: string }>>> = {
  400: { code: "VALIDATION_FAILED", message: "The request could not be read. Reload the page and try again." },
  404: { code: "NOT_FOUND", message: "No such page or API route. Check the address." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "The request is too large. Send less at once and try again." },
  415: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send the request as JSON." },
  429: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute and try again." },
};

/**
 * Sends every error as the shared envelope (AC 28). Client errors are not logged with their message, which can
 * quote the request body (a JSON parse error does); server errors are logged in full, redacted, and sent as INTERNAL.
 */
export function handleError(error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof ApiError) {
    if (error.status >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    return reply.code(error.status).send(error.toEnvelope());
  }
  const status = error.statusCode ?? 500;
  const known = FRAMEWORK_ERRORS[status];
  if (status < 500 && known !== undefined) {
    request.log.info({ code: known.code, frameworkCode: error.code }, "request rejected");
    return reply.code(ERROR_CODES[known.code].status).send(new ApiError(known.code, known.message).toEnvelope());
  }
  if (status < 500) {
    request.log.warn({ status, frameworkCode: error.code }, "request rejected with an unmapped status");
    return reply.code(400).send(new ApiError("VALIDATION_FAILED", "The request is not valid.").toEnvelope());
  }
  request.log.error({ err: error }, "request failed");
  return reply.code(500).send(new ApiError("INTERNAL", "Something went wrong on our side. Try again in a moment.").toEnvelope());
}
