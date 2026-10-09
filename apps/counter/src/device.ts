import {
  COUNTER_BUILT_AT_HEADER,
  devicePairProofPayload,
  deviceTokenSigningPayload,
  interpretErrorResponse,
  interpretNetworkFailure,
  pairResponseSchema,
  tokenRenewalResponseSchema,
  type DevicePublicKeyJwk,
  type InterpretedError,
} from "@cafe-loyalty/shared";
import type { z } from "zod";
import { deleteMeta, getMeta, setMeta, type DeviceRecord } from "./storage.js";

/** Requests give up after this long; queued work is kept and sent again. */
const REQUEST_TIMEOUT_MS = 15_000;
/** A token this close to expiring is renewed before use. */
const RENEW_BEFORE_MS = 60_000;

/** A request that failed: the server's answer, or the network failure, as the shared envelope rules read it (AC 28). */
export class RequestError extends Error {
  readonly failure: InterpretedError;

  constructor(failure: InterpretedError) {
    super(failure.message);
    this.name = "RequestError";
    this.failure = failure;
  }
}

/** The server no longer accepts this device: it was removed (revoked), or must pair again (AC 18, 21). */
export class DeviceUnpairedError extends Error {
  readonly reason: "revoked" | "pairing_required";

  constructor(reason: "revoked" | "pairing_required") {
    super(
      reason === "revoked"
        ? "The owner removed this phone. Ask them for a pairing code to use it again; its waiting stamps are kept."
        : "This phone must be paired again. Ask the owner for a pairing code; its waiting stamps are kept.",
    );
    this.name = "DeviceUnpairedError";
    this.reason = reason;
  }
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** An ECDSA P-256 / SHA-256 signature in WebCrypto's raw form, base64url, as the server verifies it. */
export async function signText(privateKey: CryptoKey, text: string): Promise<string> {
  return toBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(text)));
}

interface Reply {
  status: number;
  text: string;
}

async function send(method: "GET" | "POST", path: string, options: { body?: unknown; token?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { [COUNTER_BUILT_AT_HEADER]: __BUILT_AT__ };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  try {
    const response = await fetch(path, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
  } catch {
    throw new RequestError(interpretNetworkFailure());
  }
}

function parseReply<T extends z.ZodType>(schema: T, reply: Reply): z.output<T> {
  let body: unknown;
  try {
    body = JSON.parse(reply.text);
  } catch {
    body = undefined;
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new RequestError({
      code: null,
      message: "The server sent an answer this app cannot read. Your work is kept; reload the page and try again.",
      retryable: true,
      status: reply.status,
    });
  }
  return result.data;
}

/** Marks the device unpaired, keeping its key and queue; a removed device also forgets the PIN hashes (AC 21). */
async function unpair(reason: "revoked" | "pairing_required"): Promise<never> {
  const device = await getMeta("device");
  if (device !== undefined) {
    await setMeta("device", { ...device, paired: false, unpairedReason: reason });
  }
  await deleteMeta(...(reason === "revoked" ? (["token", "staff", "barista"] as const) : (["token"] as const)));
  throw new DeviceUnpairedError(reason);
}

async function fail(reply: Reply): Promise<never> {
  const failure = interpretErrorResponse(reply.status, reply.text);
  if (failure.code === "DEVICE_REVOKED") {
    return unpair("revoked");
  }
  if (failure.code === "PAIRING_REQUIRED") {
    return unpair("pairing_required");
  }
  throw new RequestError(failure);
}

/**
 * Pairs this phone with a code from the owner's dashboard (AC 17): a new non-extractable key, and, when the phone was
 * paired before, a proof from its old key so it keeps its device id and its queue still syncs (AC 18). The code is
 * used up by the first success, so after a lost answer the owner must create a new one.
 */
export async function pairDevice(code: string): Promise<DeviceRecord> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const publicKey: DevicePublicKeyJwk = { kty: "EC", crv: "P-256", x: exported.x ?? "", y: exported.y ?? "" };
  const old = await getMeta("device");
  const previous =
    old === undefined
      ? undefined
      : { deviceId: old.deviceId, keyId: old.keyId, signature: await signText(old.privateKey, devicePairProofPayload(old, publicKey)) };
  let reply: Reply;
  try {
    reply = await send("POST", "/api/device/pair", { body: { code, publicKey, ...(previous === undefined ? {} : { previous }) } });
  } catch (error) {
    if (error instanceof RequestError) {
      throw new RequestError({
        ...error.failure,
        message: "Could not reach the server, so the pairing is not confirmed. Check the connection and try again; if the code no longer works, ask the owner for a new one.",
      });
    }
    throw error;
  }
  if (reply.status !== 201) {
    return fail(reply);
  }
  const paired = parseReply(pairResponseSchema, reply);
  const device: DeviceRecord = {
    deviceId: paired.deviceId,
    keyId: paired.keyId,
    privateKey: keys.privateKey,
    deviceName: paired.deviceName,
    cafe: paired.cafe,
    paired: true,
    unpairedReason: null,
  };
  // Baristas and their PINs belong to one café.
  if (old !== undefined && old.cafe.id !== paired.cafe.id) {
    await deleteMeta("staff", "barista");
  }
  await setMeta("device", device);
  await setMeta("token", { accessToken: paired.accessToken, expiresAt: paired.accessTokenExpiresAt });
  return device;
}

let renewal: Promise<string> | undefined;
let lastIssuedAt = 0;

async function renew(): Promise<string> {
  const device = await getMeta("device");
  if (device?.paired !== true) {
    throw new DeviceUnpairedError(device?.unpairedReason ?? "pairing_required");
  }
  // A fresh issuedAt for every attempt, always later than the last one sent (the server refuses replays).
  lastIssuedAt = Math.max(Date.now(), lastIssuedAt + 1);
  const fields = { deviceId: device.deviceId, keyId: device.keyId, issuedAt: new Date(lastIssuedAt).toISOString() };
  const reply = await send("POST", "/api/device/token", { body: { ...fields, signature: await signText(device.privateKey, deviceTokenSigningPayload(fields)) } });
  if (reply.status !== 200) {
    return fail(reply);
  }
  const token = parseReply(tokenRenewalResponseSchema, reply);
  await setMeta("token", { accessToken: token.accessToken, expiresAt: token.accessTokenExpiresAt });
  return token.accessToken;
}

/** Renews the access token with the device key, one renewal at a time however many requests need it (AC 18). */
export function renewToken(): Promise<string> {
  renewal ??= renew().finally(() => {
    renewal = undefined;
  });
  return renewal;
}

async function currentToken(): Promise<string> {
  const token = await getMeta("token");
  return token !== undefined && Date.parse(token.expiresAt) - Date.now() > RENEW_BEFORE_MS ? token.accessToken : renewToken();
}

/**
 * Calls a device route with the access token, renewing it first when it is about to expire and once more when the
 * server answers TOKEN_EXPIRED. Throws DeviceUnpairedError on DEVICE_REVOKED or PAIRING_REQUIRED, RequestError otherwise.
 */
export async function deviceRequest<T extends z.ZodType>(method: "GET" | "POST", path: string, schema: T, body?: unknown): Promise<z.output<T>> {
  const options = body === undefined ? {} : { body };
  let reply = await send(method, path, { ...options, token: await currentToken() });
  if (reply.status === 401 && interpretErrorResponse(reply.status, reply.text).code === "TOKEN_EXPIRED") {
    reply = await send(method, path, { ...options, token: await renewToken() });
  }
  if (reply.status < 200 || reply.status > 299) {
    return fail(reply);
  }
  return parseReply(schema, reply);
}
