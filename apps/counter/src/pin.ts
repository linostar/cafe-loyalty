import { fromBase64Url, toBase64Url } from "./device.js";
import { recordEvent } from "./sync.js";
import { deleteLockout, getLockout, putLockout, type StaffEntry } from "./storage.js";

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
  const lockout = await getLockout(staff.id);
  if (lockout?.lockedUntil != null && lockout.lockedUntil > now) {
    return { status: "locked", lockedUntil: lockout.lockedUntil };
  }
  if (await pinMatches(staff, pin)) {
    if (lockout !== undefined) {
      await deleteLockout(staff.id);
    }
    return { status: "accepted" };
  }
  const failures = (lockout?.failures ?? 0) + 1;
  const delay = lockoutDelayMs(failures);
  if (delay === 0) {
    await putLockout({ staffId: staff.id, failures, lockedUntil: null });
    return { status: "wrong", attemptsLeft: PIN_FREE_ATTEMPTS + 1 - failures };
  }
  const lockedUntil = now + delay;
  await putLockout({ staffId: staff.id, failures, lockedUntil });
  await recordEvent("staff.pin_lockout", 1, staff.id, { failedAttempts: failures, lockedUntil: new Date(lockedUntil).toISOString() });
  return { status: "locked", lockedUntil };
}
