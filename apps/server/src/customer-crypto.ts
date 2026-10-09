import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cardQrSigningPayload, formatCardQr, parseCardQr, type CardQrFields } from "@cafe-loyalty/shared";

export interface Keyring {
  /** Newest first: the first key protects new data, the others only read old data. */
  keys: readonly { id: string; key: Buffer }[];
}

export interface CustomerSecrets {
  phoneLookupPepper: Buffer;
  phoneEncryption: Keyring;
  cardQr: Keyring;
}

const current = (ring: Keyring) => {
  const [first] = ring.keys;
  if (first === undefined) {
    throw new Error("A keyring needs at least one key.");
  }
  return first;
};

/** HMAC of an E.164 number with the pepper (AC 6); the "phone:" prefix keeps it apart from email lookups. */
export const phoneLookup = (secrets: CustomerSecrets, e164: string): Buffer =>
  createHmac("sha256", secrets.phoneLookupPepper).update(`phone:${e164}`).digest();

/** HMAC of a lower-case recovery email with the pepper. */
export const emailLookup = (secrets: CustomerSecrets, email: string): Buffer =>
  createHmac("sha256", secrets.phoneLookupPepper).update(`email:${email}`).digest();

/** AES-256-GCM with a random 12-byte IV: IV, 16-byte tag and ciphertext, with the id of the key used. */
export function encryptPhone(secrets: CustomerSecrets, e164: string): { keyId: string; ciphertext: Buffer } {
  const { id, key } = current(secrets.phoneEncryption);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(e164, "utf8"), cipher.final()]);
  return { keyId: id, ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]) };
}

/** The number encrypted by encryptPhone; throws if the key is unknown or the data was altered. */
export function decryptPhone(secrets: CustomerSecrets, keyId: string, ciphertext: Buffer): string {
  const entry = secrets.phoneEncryption.keys.find((candidate) => candidate.id === keyId);
  if (entry === undefined) {
    throw new Error(`No phone encryption key has id ${keyId}.`);
  }
  const decipher = createDecipheriv("aes-256-gcm", entry.key, ciphertext.subarray(0, 12));
  decipher.setAuthTag(ciphertext.subarray(12, 28));
  return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString("utf8");
}

const qrMac = (key: Buffer, fields: CardQrFields): Buffer => createHmac("sha256", key).update(cardQrSigningPayload(fields)).digest();

/** A card's QR token, signed with the newest QR key (AC 7). */
export function signCardQr(secrets: CustomerSecrets, card: Omit<CardQrFields, "keyId">): string {
  const { id, key } = current(secrets.cardQr);
  const fields = { ...card, keyId: id };
  return formatCardQr(fields, qrMac(key, fields).toString("base64url"));
}

/**
 * The card, café and epoch of a QR token whose signature is valid, compared in constant time (AC 7), or null. The
 * caller still checks the epoch against the card's current one.
 */
export function verifyCardQr(secrets: CustomerSecrets, token: string): Omit<CardQrFields, "keyId"> | null {
  const parsed = parseCardQr(token);
  const entry = parsed === null ? undefined : secrets.cardQr.keys.find((candidate) => candidate.id === parsed.keyId);
  if (parsed === null || entry === undefined) {
    return null;
  }
  const expected = qrMac(entry.key, parsed);
  const given = Buffer.from(parsed.mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  return { cardId: parsed.cardId, cafeId: parsed.cafeId, epoch: parsed.epoch };
}
