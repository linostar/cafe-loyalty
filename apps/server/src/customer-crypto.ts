import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { currentKey, type Keyring } from "@cafe-loyalty/db";

// Card QR signing lives in the db package, which the worker shares.
export { signCardQr, verifyCardQr, type Keyring } from "@cafe-loyalty/db";

export interface CustomerSecrets {
  phoneLookupPepper: Buffer;
  phoneEncryption: Keyring;
  cardQr: Keyring;
}

/** HMAC of an E.164 number with the pepper (AC 6); the "phone:" prefix keeps it apart from email lookups. */
export const phoneLookup = (secrets: CustomerSecrets, e164: string): Buffer =>
  createHmac("sha256", secrets.phoneLookupPepper).update(`phone:${e164}`).digest();

/** HMAC of a lower-case recovery email with the pepper. */
export const emailLookup = (secrets: CustomerSecrets, email: string): Buffer =>
  createHmac("sha256", secrets.phoneLookupPepper).update(`email:${email}`).digest();

/** AES-256-GCM with a random 12-byte IV: IV, 16-byte tag and ciphertext, with the id of the key used. */
export function encryptPhone(secrets: CustomerSecrets, e164: string): { keyId: string; ciphertext: Buffer } {
  const { id, key } = currentKey(secrets.phoneEncryption);
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
