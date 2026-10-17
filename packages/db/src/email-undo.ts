import { createHmac, timingSafeEqual } from "node:crypto";
import { currentKey, type Keyring } from "./card-qr.js";

/**
 * The undo link sent to a card's old recovery email when it is changed: the card's café and id, an expiry, and a
 * keyed hash of the old email's lookup, signed with the card QR keys under its own prefix, so it is never stored and
 * carries no personal data. Not bound to the card's epoch: it must still work after the new address has run recovery.
 */
const EMAIL_UNDO_SIGNING_PREFIX = "cafe-loyalty/email-undo/v1\n";

/** An undo link works for this long. */
export const EMAIL_UNDO_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Where an undo page is served, on PUBLIC_URL. */
export const EMAIL_UNDO_PATH = "/u/";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{11})\.([a-z0-9]{1,16})\.([A-Za-z0-9_-]{16})$/;

const compact = (uuid: string): string => Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
const expand = (part: string): string => {
  const hex = Buffer.from(part, "base64url").toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
// Truncated HMAC-SHA256: 64 bits for the binding (only compared with the address typed in, behind a rate limit) and
// 96 for the signature, so the token stays within Fastify's 100-character route parameter with a short key id.
const bindingOf = (key: Buffer, emailLookup: Buffer): Buffer =>
  createHmac("sha256", key).update(`${EMAIL_UNDO_SIGNING_PREFIX}email\n`).update(emailLookup).digest().subarray(0, 8);
const mac = (key: Buffer, cafeId: string, cardId: string, expires: string, binding: string): Buffer =>
  createHmac("sha256", key).update(`${EMAIL_UNDO_SIGNING_PREFIX}${cafeId}\n${cardId}\n${expires}\n${binding}`).digest().subarray(0, 12);

/** The token of a card's undo link for its old email's lookup, signed with the newest QR key, valid for 7 days from `now` (ms). */
export function signEmailUndoToken(secrets: { cardQr: Keyring }, card: { cafeId: string; cardId: string; emailLookup: Buffer }, now = Date.now()): string {
  const { id, key } = currentKey(secrets.cardQr);
  const expires = (Math.floor(now / 1000) + EMAIL_UNDO_TTL_SECONDS).toString(36);
  const binding = bindingOf(key, card.emailLookup).toString("base64url");
  return `${compact(card.cafeId)}.${compact(card.cardId)}.${expires}.${binding}.${id}.${mac(key, card.cafeId, card.cardId, expires, binding).toString("base64url")}`;
}

/**
 * The café and card of an unexpired token whose signature is valid (compared in constant time), with `isFor`, which
 * tells whether an email lookup is the one the link was sent for; or null.
 */
export function verifyEmailUndoToken(
  secrets: { cardQr: Keyring },
  token: string,
  now = Date.now(),
): { cafeId: string; cardId: string; isFor: (emailLookup: Buffer) => boolean } | null {
  const parts = TOKEN.exec(token);
  if (parts === null) {
    return null;
  }
  const [, cafePart = "", cardPart = "", expires = "", binding = "", keyId, macPart = ""] = parts;
  const entry = secrets.cardQr.keys.find((candidate) => candidate.id === keyId);
  const cafeId = expand(cafePart);
  const cardId = expand(cardPart);
  // base64url of 16 bytes round-trips only from its canonical form; a different spelling is refused.
  if (entry === undefined || !UUID.test(cafeId) || !UUID.test(cardId) || compact(cafeId) !== cafePart || compact(cardId) !== cardPart) {
    return null;
  }
  const given = Buffer.from(macPart, "base64url");
  const expected = mac(entry.key, cafeId, cardId, expires, binding);
  if (given.length !== expected.length || given.toString("base64url") !== macPart || !timingSafeEqual(given, expected) || parseInt(expires, 36) * 1000 <= now) {
    return null;
  }
  const bound = Buffer.from(binding, "base64url");
  return { cafeId, cardId, isFor: (emailLookup) => timingSafeEqual(bound, bindingOf(entry.key, emailLookup)) };
}
