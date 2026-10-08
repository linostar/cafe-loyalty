import { errorDetailSchema, interpretErrorResponse, type ErrorDetail, type InterpretedError } from "@cafe-loyalty/shared";
import { z } from "zod";

/** Requests give up after this long, so a stalled connection never leaves a form waiting forever. */
const REQUEST_TIMEOUT_MS = 15_000;

/** A failed API request, with the server's message (or one for the network failure) and any per-field problems. */
export class ApiRequestError extends Error {
  readonly failure: InterpretedError;
  readonly details: readonly ErrorDetail[];

  constructor(failure: InterpretedError, details: readonly ErrorDetail[] = []) {
    super(failure.message);
    this.name = "ApiRequestError";
    this.failure = failure;
    this.details = details;
  }
}

const detailsSchema = z.object({ details: z.array(errorDetailSchema) });

function detailsOf(body: string): ErrorDetail[] {
  try {
    const parsed = detailsSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.details : [];
  } catch {
    return [];
  }
}

/**
 * Calls the API on this site. Resolves with the parsed body (undefined for 204); rejects with ApiRequestError
 * for an error response, an unreadable response or a network failure.
 */
export async function apiRequest<T extends z.ZodType>(method: "GET" | "POST", path: string, schema: T, body?: unknown): Promise<z.output<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiRequestError({ code: null, message: "Could not reach the server. Check your connection and try again.", retryable: true, status: null });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ApiRequestError(interpretErrorResponse(response.status, text), detailsOf(text));
  }
  let parsed: unknown;
  try {
    parsed = response.status === 204 ? undefined : JSON.parse(text);
  } catch {
    parsed = Symbol("unreadable");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ApiRequestError({
      code: null,
      message: "The server sent a response this page cannot read. Reload the page and try again.",
      retryable: true,
      status: response.status,
    });
  }
  return result.data;
}

export const noContent = z.undefined();
export const messageSchema = z.object({ message: z.string() });
