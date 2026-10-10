import { createHmac, timingSafeEqual } from "node:crypto";
import type { Transaction } from "kysely";
import { currentKey, type Keyring } from "./card-qr.js";
import type { Database } from "./schema.js";

/**
 * A feedback request's link (AC 37): its café and id, signed with the card QR keys under its own prefix, so a link
 * cannot be made for another request and neither the server nor the worker stores it. Shared by both, which put it
 * on the card's passes and web card.
 */
const FEEDBACK_SIGNING_PREFIX = "cafe-loyalty/feedback-link/v1\n";

/** Where a feedback page is served, on PUBLIC_URL. */
export const FEEDBACK_PATH = "/f/";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([a-z0-9]{1,16})\.([A-Za-z0-9_-]{22})$/;

const compact = (uuid: string): string => Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
const expand = (part: string): string => {
  const hex = Buffer.from(part, "base64url").toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
// 128 bits of HMAC-SHA256.
const mac = (key: Buffer, cafeId: string, requestId: string): Buffer =>
  createHmac("sha256", key).update(`${FEEDBACK_SIGNING_PREFIX}${cafeId}\n${requestId}`).digest().subarray(0, 16);

/** The token of a request's link, signed with the newest QR key. */
export function signFeedbackToken(secrets: { cardQr: Keyring }, request: { cafeId: string; requestId: string }): string {
  const { id, key } = currentKey(secrets.cardQr);
  return `${compact(request.cafeId)}.${compact(request.requestId)}.${id}.${mac(key, request.cafeId, request.requestId).toString("base64url")}`;
}

/** The café and request of a token whose signature is valid (compared in constant time), or null. */
export function verifyFeedbackToken(secrets: { cardQr: Keyring }, token: string): { cafeId: string; requestId: string } | null {
  const parts = TOKEN.exec(token);
  if (parts === null) {
    return null;
  }
  const [, cafePart = "", requestPart = "", keyId, macPart = ""] = parts;
  const entry = secrets.cardQr.keys.find((candidate) => candidate.id === keyId);
  const cafeId = expand(cafePart);
  const requestId = expand(requestPart);
  // base64url of 16 bytes round-trips only from its canonical form; a different spelling is refused.
  if (entry === undefined || !UUID.test(cafeId) || !UUID.test(requestId) || compact(cafeId) !== cafePart || compact(requestId) !== requestPart) {
    return null;
  }
  const given = Buffer.from(macPart, "base64url");
  const expected = mac(entry.key, cafeId, requestId);
  // Canonical too: the last character's unused bits would otherwise let several spellings verify.
  return given.length === expected.length && given.toString("base64url") === macPart && timingSafeEqual(given, expected) ? { cafeId, requestId } : null;
}

/** A request's feedback page on the server at `publicUrl`. */
export const feedbackUrl = (publicUrl: string, secrets: { cardQr: Keyring }, request: { cafeId: string; requestId: string }): string =>
  new URL(`${FEEDBACK_PATH}${signFeedbackToken(secrets, request)}`, publicUrl).toString();

/** The card's latest feedback request, which its passes and web card link to, inside withCafe for its café; or undefined. */
export async function loadFeedbackRequest(trx: Transaction<Database>, cardId: string): Promise<{ cafeId: string; requestId: string } | undefined> {
  const request = await trx
    .selectFrom("feedback_requests")
    .select(["id", "cafe_id"])
    .where("card_id", "=", cardId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  return request === undefined ? undefined : { cafeId: request.cafe_id, requestId: request.id };
}
