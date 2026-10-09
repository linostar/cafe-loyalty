import { createHmac, timingSafeEqual } from "node:crypto";
import { cardQrSigningPayload, formatCardQr, parseCardQr, type CardQrFields } from "@cafe-loyalty/shared";
import { z } from "zod";

export interface Keyring {
  /** Newest first: the first key protects new data, the others only read old data. */
  keys: readonly { id: string; key: Buffer }[];
}

/** The newest key of a keyring, which protects new data. */
export function currentKey(ring: Keyring): { id: string; key: Buffer } {
  const [first] = ring.keys;
  if (first === undefined) {
    throw new Error("A keyring needs at least one key.");
  }
  return first;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A keyring setting: comma-separated `id:base64key` entries of 32-byte keys, the newest (used for new data) first.
 * Older keys stay listed while data made with them may still exist.
 */
export const keyringSchema = z.string().transform((value, context): Keyring["keys"] => {
  const keys = value.split(",").map((entry) => {
    const [id = "", key = ""] = entry.trim().split(":");
    // Strictly base64: Buffer.from would otherwise skip stray characters silently.
    return { id, key: BASE64.test(key) ? Buffer.from(key, "base64") : Buffer.alloc(0) };
  });
  const valid =
    keys.length > 0 &&
    keys.every((entry) => /^[a-z0-9]{1,16}$/.test(entry.id) && entry.key.length === 32) &&
    new Set(keys.map((entry) => entry.id)).size === keys.length;
  if (!valid) {
    context.addIssue({ code: "custom", message: "Use comma-separated id:key entries: ids of 1 to 16 lower-case letters or digits, each key 32 bytes in base64, newest first." });
    return z.NEVER;
  }
  return keys;
});

const qrMac = (key: Buffer, fields: CardQrFields): Buffer => createHmac("sha256", key).update(cardQrSigningPayload(fields)).digest();

/**
 * A card's QR token, signed with the newest QR key (AC 7). Shared by the server (web card, Apple pass, Google save
 * link) and the worker (Google pass updates).
 */
export function signCardQr(secrets: { cardQr: Keyring }, card: Omit<CardQrFields, "keyId">): string {
  const { id, key } = currentKey(secrets.cardQr);
  const fields = { ...card, keyId: id };
  return formatCardQr(fields, qrMac(key, fields).toString("base64url"));
}

/**
 * The card, café and epoch of a QR token whose signature is valid, compared in constant time (AC 7), or null. The
 * caller still checks the epoch against the card's current one.
 */
export function verifyCardQr(secrets: { cardQr: Keyring }, token: string): Omit<CardQrFields, "keyId"> | null {
  const parsed = parseCardQr(token);
  const entry = parsed === null ? undefined : secrets.cardQr.keys.find((candidate) => candidate.id === parsed.keyId);
  if (parsed === null || entry === undefined) {
    return null;
  }
  // Compared as canonical text, not decoded bytes: base64url decoding ignores the last character's spare bits, so
  // several spellings of one mac would otherwise all verify.
  const expected = Buffer.from(qrMac(entry.key, parsed).toString("base64url"));
  const given = Buffer.from(parsed.mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  return { cardId: parsed.cardId, cafeId: parsed.cafeId, epoch: parsed.epoch };
}
