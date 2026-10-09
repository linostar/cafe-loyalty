import { describe, expect, it } from "vitest";
import { attemptPin, lockoutDelayMs, pinMatches } from "./pin.js";
import { closeStorage, getLockout, listQueued } from "./storage.js";
import { staffEntry, storePairedDevice } from "./test-helpers.js";

const STAFF_ID = "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e";

describe("lockoutDelayMs", () => {
  it("allows four wrong PINs, then pauses 30 s, doubling up to an hour (AC 19)", () => {
    expect([1, 2, 3, 4].map(lockoutDelayMs)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8].map(lockoutDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(lockoutDelayMs(12)).toBe(3_600_000);
    expect(lockoutDelayMs(40)).toBe(3_600_000);
  });
});

describe("attemptPin", () => {
  it("checks a PIN against the server's PBKDF2 hash", async () => {
    const rami = await staffEntry(STAFF_ID, "Rami", "482913");
    expect(await pinMatches(rami, "482913")).toBe(true);
    expect(await pinMatches(rami, "482914")).toBe(false);
  });

  it("locks out after the fifth wrong PIN, keeps the lockout in IndexedDB and reports it at sync (AC 19)", async () => {
    await storePairedDevice();
    const rami = await staffEntry(STAFF_ID, "Rami", "482913");
    const start = Date.parse("2026-10-01T08:00:00.000Z");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await attemptPin(rami, "000000", start)).toEqual({ status: "wrong", attemptsLeft: 5 - attempt });
    }
    expect(await attemptPin(rami, "000000", start)).toEqual({ status: "locked", lockedUntil: start + 30_000 });
    // Locked, so even the right PIN is not checked; reopening storage (a reload) changes nothing.
    await closeStorage();
    expect(await attemptPin(rami, "482913", start + 29_000)).toEqual({ status: "locked", lockedUntil: start + 30_000 });
    expect(await listQueued(10)).toMatchObject([
      { type: "staff.pin_lockout", event: { staffId: STAFF_ID, payload: { failedAttempts: 5, lockedUntil: "2026-10-01T08:00:30.000Z" } } },
    ]);

    expect(await attemptPin(rami, "000000", start + 31_000)).toEqual({ status: "locked", lockedUntil: start + 91_000 });
    expect(await attemptPin(rami, "482913", start + 92_000)).toEqual({ status: "accepted" });
    expect(await getLockout(STAFF_ID)).toBeUndefined();
    expect(await listQueued(10)).toHaveLength(2);
  });
});
