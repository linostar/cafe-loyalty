import { fromBase64Url, toBase64Url } from "./device.js";
import { recordEvent } from "./sync.js";
import { countPinAttempt, deleteLockout, type StaffEntry } from "./storage.js";

/** Wrong PINs in a row allowed before the device locks that barista out (AC 19). */
export const PIN_FREE_ATTEMPTS = 4;
const FIRST_LOCKOUT_MS = 30_000;
const LONGEST_LOCKOUT_MS = 60 * 60 * 1000;

/** How long the device refuses PINs after `failures` wrong ones in a row: none, then 30 s doubling up to an hour. */
export function lockoutDelayMs(failures: number): number {
  if (failures <= PIN_FREE_ATTEMPTS) {
    return 0;
  }
  return Math.min(FIRST_LOCKOUT_MS * 2 ** (failures - PIN_FREE_ATTEMPTS - 1), LONGEST_LOCKOUT_MS);
}

/** Whether `pin` matches the barista's PBKDF2-SHA256 hash, derived as the server derived it (AC 19). */
export async function pinMatches(staff: StaffEntry, pin: string): Promise<boolean> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(staff.pinSalt), iterations: staff.pinIterations }, material, 256);
  return toBase64Url(bits) === staff.pinHash;
}

export type PinAttempt = { status: "accepted" } | { status: "wrong"; attemptsLeft: number } | { status: "locked"; lockedUntil: number };

/**
 * Checks a barista's PIN against the lockout kept in IndexedDB, so it holds offline and across reloads (AC 19). A
 * locked-out barista's PIN is not checked at all. Each wrong PIN that starts a lockout queues a `staff.pin_lockout`
 * event, which reports it to the owner at the next sync.
 */
export async function attemptPin(staff: StaffEntry, pin: string, now = Date.now()): Promise<PinAttempt> {
  // Counted before the PIN is checked, so wrong PINs typed in several tabs at once are all counted.
  // ponytail: the lockout trusts the phone's clock; setting it ahead ends a lockout early. A monotonic clock would
  // not survive reloads; the report at sync still tells the owner.
  const count = await countPinAttempt(staff.id, now, lockoutDelayMs);
  if (count.status === "locked") {
    return count;
  }
  if (await pinMatches(staff, pin)) {
    await deleteLockout(staff.id);
    return { status: "accepted" };
  }
  if (count.lockedUntil === null) {
    return { status: "wrong", attemptsLeft: PIN_FREE_ATTEMPTS + 1 - count.failures };
  }
  await recordEvent("staff.pin_lockout", 1, staff.id, { failedAttempts: count.failures, lockedUntil: new Date(count.lockedUntil).toISOString() });
  return { status: "locked", lockedUntil: count.lockedUntil };
}
