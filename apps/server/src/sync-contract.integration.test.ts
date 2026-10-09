import { randomBytes } from "node:crypto";
import { withCafe } from "@cafe-loyalty/db";
import { syncResponseSchema } from "@cafe-loyalty/shared";
import { describe, expect, it, vi } from "vitest";
import { hashToken, newToken } from "./credentials.js";
import { encryptPhone, phoneLookup, type CustomerSecrets } from "./customer-crypto.js";
import { inSupportWindow, loadSyncFixtures, type SyncFixture } from "./testing/sync-fixtures.js";
import { TEST_SECRETS, useApiHarness, withBearer } from "./testing/api-harness.js";

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

/** The fixture's own test keys, so its QR codes and phone lookups match. */
const secretsOf = (fixture: SyncFixture): CustomerSecrets => ({
  phoneLookupPepper: Buffer.from(fixture.secrets.phoneLookupPepper, "base64"),
  phoneEncryption: TEST_SECRETS.phoneEncryption,
  cardQr: { keys: [{ id: fixture.secrets.cardQrKey.id, key: Buffer.from(fixture.secrets.cardQrKey.key, "base64") }] },
});

/**
 * The café, barista, device, key, order type and cards the fixture's events name, with an access token for that
 * device. The phone card is already confirmed at a counter, so it may be stamped by phone number.
 */
async function seed(fixture: SyncFixture): Promise<string> {
  const cafeId = fixture.cafeId;
  const token = newToken();
  const secrets = secretsOf(fixture);
  const encrypted = encryptPhone(secrets, fixture.cards.phone.phone);
  const { rows } = await context.admin.query<{ id: string }>(
    "INSERT INTO app.customers (phone_lookup, phone_ciphertext, phone_key_id) VALUES ($1, $2, $3) RETURNING id",
    [phoneLookup(secrets, fixture.cards.phone.phone), encrypted.ciphertext, encrypted.keyId],
  );
  await withCafe(context.testDb.app.db, cafeId, async (trx) => {
    await trx.insertInto("cafes").values({ id: cafeId, name: "Café Fixture" }).execute();
    await trx
      .insertInto("order_types")
      .values({ id: fixture.orderTypeId, cafe_id: cafeId, name_ar: "قهوة", name_en: "Coffee", price_cents: 350, cost_cents: 120, stamps_earned: 1 })
      .execute();
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
  await context.admin.query(
    `INSERT INTO app.cards (id, cafe_id, customer_id, web_secret_hash, privacy_accepted_at, phone_confirmed_at)
     VALUES ($1, $3, NULL, $4, now(), NULL), ($2, $3, $5, $6, now(), now())`,
    [fixture.cards.qr.cardId, fixture.cards.phone.cardId, cafeId, randomBytes(32), rows[0]?.id, randomBytes(32)],
  );
  return token;
}

describe("sync contract", () => {
  it("has frozen fixtures, each one readable", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(supported)("replays $name with the results it got when it shipped", async ({ fixture }) => {
    const { app } = await context.harness({ secrets: secretsOf(fixture) });
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
