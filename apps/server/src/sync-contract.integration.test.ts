import { randomBytes } from "node:crypto";
import { withCafe } from "@cafe-loyalty/db";
import { syncResponseSchema } from "@cafe-loyalty/shared";
import { describe, expect, it, vi } from "vitest";
import { hashToken, newToken } from "./credentials.js";
import { inSupportWindow, loadSyncFixtures, type SyncFixture } from "./testing/sync-fixtures.js";
import { useApiHarness, withBearer } from "./testing/api-harness.js";

/**
 * Sync contract (AC 27): every counter release still inside the support window must get the same answers from this
 * API as when it shipped. The release's build time is BUILT_AT, as the release build sets it (now, when unset).
 */
const context = useApiHarness();
const releaseBuiltAt = process.env.BUILT_AT === undefined ? new Date() : new Date(process.env.BUILT_AT);
const fixtures = await loadSyncFixtures();
const newest = fixtures.reduce<(typeof fixtures)[number] | undefined>(
  (latest, entry) => (latest === undefined || Date.parse(entry.fixture.builtAt) > Date.parse(latest.fixture.builtAt) ? entry : latest),
  undefined,
);
// Every release in the window, and always the newest: the counter of the latest release is in use whatever its age.
const supported = fixtures.filter((entry) => entry === newest || inSupportWindow(entry.fixture.builtAt, releaseBuiltAt));

/** The café, barista, device and key the fixture's events name, with an access token for that device. */
async function seed(fixture: SyncFixture): Promise<string> {
  const { cafeId } = await context.invite("Café Fixture");
  const token = newToken();
  await withCafe(context.testDb.app.db, cafeId, async (trx) => {
    await trx
      .insertInto("staff")
      .values({ id: fixture.staffId, cafe_id: cafeId, name: "Fixture barista", pin_salt: randomBytes(16), pin_hash: randomBytes(32), pin_iterations: 600_000 })
      .execute();
    await trx.insertInto("devices").values({ id: fixture.device.deviceId, cafe_id: cafeId, name: "Fixture counter" }).execute();
    await trx
      .insertInto("device_keys")
      .values({ id: fixture.device.keyId, cafe_id: cafeId, device_id: fixture.device.deviceId, public_key: JSON.stringify(fixture.device.publicKey) })
      .execute();
    await trx
      .insertInto("device_tokens")
      .values({ cafe_id: cafeId, device_id: fixture.device.deviceId, token_hash: hashToken(token), expires_at: new Date(Date.now() + 60 * 60 * 1000) })
      .execute();
  });
  return token;
}

describe("sync contract", () => {
  it("has frozen fixtures, each one readable", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(supported)("replays $name with the results it got when it shipped", async ({ fixture }) => {
    const { app } = await context.harness();
    const token = await seed(fixture);
    // At the time the events were recorded, so the clock-skew rules judge them as they did then.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(fixture.recordedAt) });
    try {
      for (const request of fixture.requests) {
        const response = await app.inject({ method: "POST", url: "/api/device/sync", headers: withBearer(token), payload: { events: request.events } });
        expect(response.statusCode).toBe(200);
        expect(syncResponseSchema.parse(response.json()).results.map(({ status, code }) => ({ status, code }))).toEqual(request.results);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
