import { z } from "zod";

/**
 * Every error code the API can return, with the HTTP status it is sent with. `retryable` says only whether the
 * same request may be sent again unchanged; it never means queued counter events may be dropped, which happens
 * only on a final per-event sync status. Add codes here only; the server and clients both read this table.
 * Per-event sync outcomes have their own codes (SYNC_RESULT_CODES).
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, retryable: false },
  /** No valid credentials: sign in. */
  UNAUTHENTICATED: { status: 401, retryable: false },
  /** The device's access token expired: renew it with the device key, then retry (AC 18). */
  TOKEN_EXPIRED: { status: 401, retryable: false },
  /** The owner revoked this device: wipe PIN hashes and unpair (AC 21). */
  DEVICE_REVOKED: { status: 401, retryable: false },
  /** The device was offline too long or its pairing is gone: pair again; the queue is kept and syncs after (AC 18). */
  PAIRING_REQUIRED: { status: 401, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  CONFLICT: { status: 409, retryable: false },
  /** A pairing code that is wrong, used, expired or burned by wrong tries: create a new one on the dashboard (AC 17). */
  PAIRING_CODE_INVALID: { status: 400, retryable: false },
  /** An invite or password reset link that is unknown, already used or expired: ask for a new one. */
  LINK_EXPIRED: { status: 410, retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, retryable: false },
  CLIENT_TOO_OLD: { status: 426, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL: { status: 500, retryable: true },
  SERVICE_UNAVAILABLE: { status: 503, retryable: true },
} as const satisfies Record<string, { status: number; retryable: boolean }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const errorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const errorDetailSchema = z.object({
  /** Dotted path of the offending field, empty for the whole request. */
  path: z.string(),
  issue: z.string(),
});

/** The single error body every API response uses (AC 28). */
export const errorEnvelopeSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.array(errorDetailSchema).optional(),
});

export type ErrorDetail = z.output<typeof errorDetailSchema>;
export type ErrorEnvelope = z.output<typeof errorEnvelopeSchema>;

/** Thrown by server code to send a specific error envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: readonly ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: readonly ErrorDetail[]) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.retryable = ERROR_CODES[code].retryable;
    this.details = details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: [...this.details] }),
    };
  }
}

/** How a client should treat a failed request. `code` is null when the response was not a recognised envelope. */
export interface InterpretedError {
  code: ErrorCode | null;
  message: string;
  retryable: boolean;
  status: number | null;
}

/** The part of an envelope a client relies on; other fields (such as details) may change shape without breaking it. */
const clientEnvelopeSchema = z.object({ code: z.string(), message: z.string() });

/**
 * Interprets a failed HTTP response for a client. A known code takes its retryable flag from ERROR_CODES.
 * Anything else (a proxy's HTML 502 page during a restart, an empty body, a code added by a newer server)
 * is treated as retryable, so queued work is kept rather than dropped (AC 28).
 */
export function interpretErrorResponse(status: number, body: string): InterpretedError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: null, message: `The server sent an unreadable response (HTTP ${String(status)}). Wait a moment and try again.`, retryable: true, status };
  }
  const envelope = clientEnvelopeSchema.safeParse(parsed);
  if (!envelope.success || !Object.hasOwn(ERROR_CODES, envelope.data.code)) {
    return { code: null, message: `The server sent an error this app does not recognise (HTTP ${String(status)}). Reload the page and try again.`, retryable: true, status };
  }
  const code = envelope.data.code as ErrorCode;
  const message = envelope.data.message.length > 0 ? envelope.data.message : `The request failed (HTTP ${String(status)}).`;
  return { code, message, retryable: ERROR_CODES[code].retryable, status };
}

/** The interpretation of a request that never got a response (offline, DNS failure, timeout). */
export function interpretNetworkFailure(): InterpretedError {
  return { code: null, message: "Could not reach the server. Your work is kept and will be sent again.", retryable: true, status: null };
}
