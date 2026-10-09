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
import { getMeta, nextIssuedAt, storePairing, storeToken, storeUnpaired, type DeviceRecord, type StoredToken } from "./storage.js";

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

/** Marks the device of `keyId` unpaired (keeping its key and queue) and reports it; see storeUnpaired (AC 21). */
export async function unpairDevice(keyId: string, reason: "revoked" | "pairing_required"): Promise<never> {
  if (!(await storeUnpaired(keyId, reason))) {
    // Another pairing replaced that key meanwhile: the answer was about the old one.
    throw new RequestError({ code: null, message: "This phone was paired again meanwhile. Try again.", retryable: true, status: null });
  }
  throw new DeviceUnpairedError(reason);
}

async function fail(reply: Reply, keyId: string): Promise<never> {
  const failure = interpretErrorResponse(reply.status, reply.text);
  if (failure.code === "DEVICE_REVOKED") {
    return unpairDevice(keyId, "revoked");
  }
  if (failure.code === "PAIRING_REQUIRED") {
    return unpairDevice(keyId, "pairing_required");
  }
  throw new RequestError(failure);
}

/** The phone still holds another café's identity, and maybe events it has not sent there (PAIRED_ELSEWHERE). */
export class PairedElsewhereError extends Error {
  readonly cafeName: string;

  constructor(cafeName: string) {
    super(`This phone is still paired with ${cafeName}. Pair it with ${cafeName} first to send what it has waiting, or start over.`);
    this.name = "PairedElsewhereError";
    this.cafeName = cafeName;
  }
}

const notConfirmed = (failure: InterpretedError) =>
  new RequestError({
    ...failure,
    message: "The pairing could not be confirmed. Check the connection and try again; if the code no longer works, ask the owner for a new one.",
  });

/**
 * Pairs this phone with a code from the owner's dashboard, in canonical form (normalizePairingCode) (AC 17): a new
 * non-extractable key, and, when the phone was paired before, a proof from its old key so it keeps its device id
 * and its queue still syncs (AC 18). A phone paired with another café is refused with PairedElsewhereError;
 * `startOver` then pairs it as a new device and drops what it queued for the other café. The code is used up by the
 * first success, so after a lost answer the owner must create a new one.
 */
export async function pairDevice(code: string, options: { startOver?: boolean } = {}): Promise<DeviceRecord> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const publicKey: DevicePublicKeyJwk = { kty: "EC", crv: "P-256", x: exported.x ?? "", y: exported.y ?? "" };
  const old = await getMeta("device");
  const previous =
    old === undefined || options.startOver === true
      ? undefined
      : { deviceId: old.deviceId, keyId: old.keyId, signature: await signText(old.privateKey, devicePairProofPayload(code, old, publicKey)) };
  let reply: Reply;
  try {
    reply = await send("POST", "/api/device/pair", { body: { code, publicKey, ...(previous === undefined ? {} : { previous }) } });
  } catch (error) {
    throw error instanceof RequestError ? notConfirmed(error.failure) : error;
  }
  if (reply.status !== 201) {
    const failure = interpretErrorResponse(reply.status, reply.text);
    if (failure.code === "PAIRED_ELSEWHERE" && old !== undefined) {
      throw new PairedElsewhereError(old.cafe.name);
    }
    // An answer this app cannot read (a proxy error, say) may come after the server paired: the code may be used.
    throw failure.code === null ? notConfirmed(failure) : new RequestError(failure);
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
  await storePairing(
    device,
    { accessToken: paired.accessToken, expiresAt: paired.accessTokenExpiresAt, keyId: paired.keyId },
    // Baristas and their PINs belong to one café.
    { forgetStaff: old !== undefined && old.cafe.id !== paired.cafe.id, forgetQueue: options.startOver === true },
  );
  return device;
}

interface Credential {
  accessToken: string;
  keyId: string;
}

let renewal: Promise<Credential> | undefined;

/** Whether `token` belongs to the paired device's current key and is not about to expire. */
function isFresh(token: StoredToken, device: DeviceRecord | undefined): boolean {
  return device?.paired === true && token.keyId === device.keyId && Date.parse(token.expiresAt) - Date.now() > RENEW_BEFORE_MS;
}

async function renew(replacing: string | undefined): Promise<Credential> {
  const device = await getMeta("device");
  if (device?.paired !== true) {
    throw new DeviceUnpairedError(device?.unpairedReason ?? "pairing_required");
  }
  // Another tab may have renewed while this one waited for the lock; never hand back the token being replaced.
  const stored = await getMeta("token");
  if (stored !== undefined && isFresh(stored, device) && stored.accessToken !== replacing) {
    return { accessToken: stored.accessToken, keyId: stored.keyId };
  }
  // A fresh issuedAt for every attempt, always later than the last one any tab sent (the server refuses replays).
  const fields = { deviceId: device.deviceId, keyId: device.keyId, issuedAt: new Date(await nextIssuedAt()).toISOString() };
  const reply = await send("POST", "/api/device/token", { body: { ...fields, signature: await signText(device.privateKey, deviceTokenSigningPayload(fields)) } });
  if (reply.status !== 200) {
    return fail(reply, device.keyId);
  }
  const token = parseReply(tokenRenewalResponseSchema, reply);
  // Dropped if the phone was paired again meanwhile: a token is only ever used with the key it was issued for.
  if (!(await storeToken({ accessToken: token.accessToken, expiresAt: token.accessTokenExpiresAt, keyId: device.keyId }))) {
    throw new RequestError({ code: null, message: "This phone was paired again meanwhile. Try again.", retryable: true, status: null });
  }
  return { accessToken: token.accessToken, keyId: device.keyId };
}

/**
 * Renews the access token with the device key, one renewal at a time however many requests and tabs need it (AC 18):
 * within a tab by sharing the running renewal, across tabs with a Web Lock where the browser has them. `replacing`
 * is the token the caller holds (expiring, or refused with TOKEN_EXPIRED), which is never returned again.
 */
export function renewToken(replacing?: string): Promise<Credential> {
  const run = () => renew(replacing);
  renewal ??= ("locks" in navigator ? navigator.locks.request("cafe-loyalty-renew-token", run) : run()).finally(() => {
    renewal = undefined;
  });
  return renewal;
}

async function currentCredential(): Promise<Credential> {
  const [device, token] = await Promise.all([getMeta("device"), getMeta("token")]);
  return token !== undefined && isFresh(token, device) ? { accessToken: token.accessToken, keyId: token.keyId } : renewToken(token?.accessToken);
}

/**
 * Calls a device route with the access token, renewing it first when it is about to expire and once more when the
 * server answers TOKEN_EXPIRED. Resolves with the body and the key of the device that was answered; throws
 * DeviceUnpairedError on DEVICE_REVOKED or PAIRING_REQUIRED, RequestError otherwise.
 */
export async function deviceRequestFor<T extends z.ZodType>(
  method: "GET" | "POST",
  path: string,
  schema: T,
  body?: unknown,
): Promise<{ body: z.output<T>; keyId: string }> {
  const options = body === undefined ? {} : { body };
  let credential = await currentCredential();
  let reply = await send(method, path, { ...options, token: credential.accessToken });
  if (reply.status === 401 && interpretErrorResponse(reply.status, reply.text).code === "TOKEN_EXPIRED") {
    credential = await renewToken(credential.accessToken);
    reply = await send(method, path, { ...options, token: credential.accessToken });
  }
  if (reply.status < 200 || reply.status > 299) {
    return fail(reply, credential.keyId);
  }
  return { body: parseReply(schema, reply), keyId: credential.keyId };
}

/** deviceRequestFor, for callers that need only the body. */
export async function deviceRequest<T extends z.ZodType>(method: "GET" | "POST", path: string, schema: T, body?: unknown): Promise<z.output<T>> {
  return (await deviceRequestFor(method, path, schema, body)).body;
}
