import { createHmac, timingSafeEqual } from "node:crypto";
import { currentKey, type Keyring } from "./card-qr.js";
import { compact, expandUuid } from "./feedback.js";

/**
 * The undo link sent to a card's old recovery email when it is changed: the card's café and id, its email change count
 * after that change (cards.email_change_seq), an expiry, and a keyed hash of the old email's lookup, signed with the card
 * QR keys under its own prefix, so it is never stored and carries no personal data. Not bound to the card's epoch: it
 * must still work after the new address has run recovery. The count orders links: an undo voids every link from a later
 * change made before it (cards.email_undo_floor, email_undo_seq), so the one sent to an address someone set and changed
 * again cannot take the card back after the first address's undo.
 */
const EMAIL_UNDO_SIGNING_PREFIX = "cafe-loyalty/email-undo/v2\n";

/** An undo link works for this long. */
export const EMAIL_UNDO_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Where an undo page is served, on PUBLIC_URL. */
export const EMAIL_UNDO_PATH = "/u/";

const TOKEN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,7})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{8})\.([a-z0-9]{1,16})\.([A-Za-z0-9_-]{16})$/;

// Truncated HMAC-SHA256: 48 bits for the binding (only compared with the address typed in, behind the token and a rate
// limit) and 96 for the signature, so the token stays within Fastify's 100-character route parameter with a short key id.
const bindingOf = (key: Buffer, emailLookup: Buffer): Buffer =>
  createHmac("sha256", key).update(`${EMAIL_UNDO_SIGNING_PREFIX}email\n`).update(emailLookup).digest().subarray(0, 6);
const mac = (key: Buffer, cafeId: string, cardId: string, seq: string, expires: string, binding: string): Buffer =>
  createHmac("sha256", key).update(`${EMAIL_UNDO_SIGNING_PREFIX}${cafeId}\n${cardId}\n${seq}\n${expires}\n${binding}`).digest().subarray(0, 12);

/**
 * The token of a card's undo link for its old email's lookup, after the change that made the card's email change count
 * `seq`, signed with the newest QR key, valid for 7 days from `now` (ms).
 */
export function signEmailUndoToken(
  secrets: { cardQr: Keyring },
  card: { cafeId: string; cardId: string; seq: number; emailLookup: Buffer },
  now = Date.now(),
): string {
  const { id, key } = currentKey(secrets.cardQr);
  const seq = card.seq.toString(36);
  const expires = (Math.floor(now / 1000) + EMAIL_UNDO_TTL_SECONDS).toString(36);
  const binding = bindingOf(key, card.emailLookup).toString("base64url");
  return `${compact(card.cafeId)}.${compact(card.cardId)}.${seq}.${expires}.${binding}.${id}.${mac(key, card.cafeId, card.cardId, seq, expires, binding).toString("base64url")}`;
}

/**
 * The café, card and email change count of an unexpired token whose signature is valid (compared in constant time), with
 * `isFor`, which tells whether an email lookup is the one the link was sent for; or null.
 */
export function verifyEmailUndoToken(
  secrets: { cardQr: Keyring },
  token: string,
  now = Date.now(),
): { cafeId: string; cardId: string; seq: number; isFor: (emailLookup: Buffer) => boolean } | null {
  const parts = TOKEN.exec(token);
  if (parts === null) {
    return null;
  }
  const [, cafePart = "", cardPart = "", seq = "", expires = "", binding = "", keyId, macPart = ""] = parts;
  const entry = secrets.cardQr.keys.find((candidate) => candidate.id === keyId);
  const cafeId = expandUuid(cafePart);
  const cardId = expandUuid(cardPart);
  if (entry === undefined || cafeId === null || cardId === null) {
    return null;
  }
  const given = Buffer.from(macPart, "base64url");
  const expected = mac(entry.key, cafeId, cardId, seq, expires, binding);
  if (given.length !== expected.length || given.toString("base64url") !== macPart || !timingSafeEqual(given, expected) || parseInt(expires, 36) * 1000 <= now) {
    return null;
  }
  const bound = Buffer.from(binding, "base64url");
  return { cafeId, cardId, seq: parseInt(seq, 36), isFor: (emailLookup) => timingSafeEqual(bound, bindingOf(entry.key, emailLookup)) };
}
