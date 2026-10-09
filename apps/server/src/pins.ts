import { pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(pbkdf2);

/**
 * PBKDF2-SHA256 iterations for staff PINs (OWASP's figure for SHA-256). Paired devices repeat this derivation with
 * WebCrypto to check a PIN offline, so it is stored per staff member and can be raised without breaking old hashes.
 */
export const STAFF_PIN_ITERATIONS = 600_000;

export interface PinHash {
  salt: Buffer;
  hash: Buffer;
  iterations: number;
}

/** A salted PBKDF2-SHA256 hash of a staff PIN (AC 19): 16-byte random salt, 32-byte hash. */
export async function hashPin(pin: string, iterations = STAFF_PIN_ITERATIONS): Promise<PinHash> {
  const salt = randomBytes(16);
  return { salt, hash: await derive(pin, salt, iterations, 32, "sha256"), iterations };
}
