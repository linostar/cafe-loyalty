import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContextError, withCafe, withLookup } from "./database.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

const READ_ONLY_TRANSACTION = "25006";

interface SeededCafe {
  cafeId: string;
  ownerId: string;
  email: string;
  sessionHash: Buffer;
  inviteHash: Buffer;
  resetHash: Buffer;
}

let testDb: TestDatabase;
let cafeA: SeededCafe;
let cafeB: SeededCafe;

const hashOf = (secret: Buffer): Buffer => createHash("sha256").update(secret).digest();

async function seed(name: string): Promise<SeededCafe> {
  const seeded = {
    cafeId: randomUUID(),
    ownerId: randomUUID(),
    email: `${name.toLowerCase()}@example.com`,
    sessionHash: hashOf(randomBytes(32)),
    inviteHash: hashOf(randomBytes(32)),
    resetHash: hashOf(randomBytes(32)),
  };
  const later = new Date(Date.now() + 3_600_000);
  await withCafe(testDb.app.db, seeded.cafeId, async (trx) => {
    await trx.insertInto("cafes").values({ id: seeded.cafeId, name }).execute();
    await trx
      .insertInto("owners")
      .values({ id: seeded.ownerId, cafe_id: seeded.cafeId, email: seeded.email, password_hash: "$argon2id$fixture" })
      .execute();
    await trx.insertInto("owner_invites").values({ cafe_id: seeded.cafeId, token_hash: seeded.inviteHash, expires_at: later }).execute();
    await trx
      .insertInto("owner_sessions")
      .values({ cafe_id: seeded.cafeId, owner_id: seeded.ownerId, token_hash: seeded.sessionHash, expires_at: later })
      .execute();
    await trx
      .insertInto("password_reset_tokens")
      .values({ cafe_id: seeded.cafeId, owner_id: seeded.ownerId, token_hash: seeded.resetHash, expires_at: later })
      .execute();
  });
  return seeded;
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  cafeA = await seed("CafeA");
  cafeB = await seed("CafeB");
});

afterAll(async () => {
  await testDb.cleanup();
});

/** Row counts of every auth table and of cafés, as seen inside one lookup. */
async function visibleCounts(key: Parameters<typeof withLookup>[1]): Promise<Record<string, number>> {
  return withLookup(testDb.app.db, key, async (trx) => {
    const counts: Record<string, number> = {};
    for (const table of ["cafes", "owners", "owner_invites", "owner_sessions", "password_reset_tokens"] as const) {
      const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(trx);
      counts[table] = result.rows[0]?.n ?? -1;
    }
    return counts;
  });
}

describe("withLookup", () => {
  it("shows only the owner with that email", async () => {
    const owner = await withLookup(testDb.app.db, { ownerEmail: cafeA.email }, (trx) =>
      trx.selectFrom("owners").select(["id", "cafe_id"]).execute(),
    );
    expect(owner).toEqual([{ id: cafeA.ownerId, cafe_id: cafeA.cafeId }]);
    expect(await visibleCounts({ ownerEmail: cafeA.email })).toEqual({
      cafes: 0,
      owners: 1,
      owner_invites: 0,
      owner_sessions: 0,
      password_reset_tokens: 0,
    });
  });

  it("shows only the session, invite or reset token with that hash", async () => {
    for (const [hash, table] of [
      [cafeB.sessionHash, "owner_sessions"],
      [cafeB.inviteHash, "owner_invites"],
      [cafeB.resetHash, "password_reset_tokens"],
    ] as const) {
      expect(await visibleCounts({ secretHash: hash })).toEqual({
        cafes: 0,
        owners: 0,
        owner_invites: 0,
        owner_sessions: 0,
        password_reset_tokens: 0,
        [table]: 1,
      });
    }
  });

  it("shows nothing for an unknown email or hash", async () => {
    const none = { cafes: 0, owners: 0, owner_invites: 0, owner_sessions: 0, password_reset_tokens: 0 };
    expect(await visibleCounts({ ownerEmail: "nobody@example.com" })).toEqual(none);
    expect(await visibleCounts({ secretHash: hashOf(randomBytes(32)) })).toEqual(none);
  });

  it("cannot write", async () => {
    const code = await errorCodeOf(
      withLookup(testDb.app.db, { secretHash: cafeA.sessionHash }, (trx) =>
        trx.deleteFrom("owner_sessions").where("token_hash", "=", cafeA.sessionHash).execute(),
      ),
    );
    expect(code).toBe(READ_ONLY_TRANSACTION);
  });

  it("rejects an empty email and a hash that is not 32 bytes before touching the database", async () => {
    await expect(withLookup(testDb.app.db, { ownerEmail: "" }, () => Promise.resolve(1))).rejects.toThrow(TenantContextError);
    await expect(withLookup(testDb.app.db, { secretHash: randomBytes(16) }, () => Promise.resolve(1))).rejects.toThrow(TenantContextError);
  });
});

describe("secret-keyed policies", () => {
  it("never let a café change another café's rows, even holding their hash", async () => {
    const affected = await withCafe(testDb.app.db, cafeA.cafeId, async (trx) => {
      await sql`SELECT set_config('app.secret_hash', ${cafeB.sessionHash.toString("hex")}, true)`.execute(trx);
      const visible = await trx.selectFrom("owner_sessions").select("id").where("cafe_id", "=", cafeB.cafeId).execute();
      const touched = await trx
        .updateTable("owner_sessions")
        .set({ last_seen_at: new Date() })
        .where("cafe_id", "=", cafeB.cafeId)
        .executeTakeFirst();
      const deleted = await trx.deleteFrom("owner_sessions").where("cafe_id", "=", cafeB.cafeId).executeTakeFirst();
      return { visible: visible.length, touched: touched.numUpdatedRows, deleted: deleted.numDeletedRows };
    });
    // The hash makes the row readable; only the café policy allows changing it.
    expect(affected).toEqual({ visible: 1, touched: 0n, deleted: 0n });
  });

  it("never let a café claim another café's invite, even holding its hash", async () => {
    const touched = await withCafe(testDb.app.db, cafeA.cafeId, async (trx) => {
      await sql`SELECT set_config('app.secret_hash', ${cafeB.inviteHash.toString("hex")}, true)`.execute(trx);
      const result = await trx.updateTable("owner_invites").set({ used_at: new Date() }).where("cafe_id", "=", cafeB.cafeId).executeTakeFirst();
      return result.numUpdatedRows;
    });
    expect(touched).toBe(0n);
  });

  it("never let a lookup by email change the owner", async () => {
    const touched = await withCafe(testDb.app.db, cafeA.cafeId, async (trx) => {
      await sql`SELECT set_config('app.owner_email', ${cafeB.email}, true)`.execute(trx);
      const result = await trx.updateTable("owners").set({ password_hash: "$argon2id$stolen" }).where("id", "=", cafeB.ownerId).executeTakeFirst();
      return result.numUpdatedRows;
    });
    expect(touched).toBe(0n);
  });

  it("keeps owner emails unique across cafés", async () => {
    const code = await errorCodeOf(
      withCafe(testDb.app.db, cafeA.cafeId, (trx) =>
        trx.insertInto("owners").values({ cafe_id: cafeA.cafeId, email: cafeB.email, password_hash: "$argon2id$fixture" }).execute(),
      ),
    );
    expect(code).toBe("23505");
  });
});

describe("device lookups", () => {
  interface SeededDevice {
    cafeId: string;
    deviceId: string;
    keyId: string;
    tokenHash: Buffer;
    pairingLookupHash: Buffer;
  }
  let deviceA: SeededDevice;
  let deviceB: SeededDevice;

  async function seedDevice(cafe: SeededCafe): Promise<SeededDevice> {
    const seeded = {
      cafeId: cafe.cafeId,
      deviceId: randomUUID(),
      keyId: randomUUID(),
      tokenHash: hashOf(randomBytes(32)),
      pairingLookupHash: hashOf(randomBytes(32)),
    };
    const later = new Date(Date.now() + 3_600_000);
    await withCafe(testDb.app.db, cafe.cafeId, async (trx) => {
      await trx.insertInto("devices").values({ id: seeded.deviceId, cafe_id: cafe.cafeId, name: "Counter" }).execute();
      await trx
        .insertInto("device_keys")
        .values({ id: seeded.keyId, cafe_id: cafe.cafeId, device_id: seeded.deviceId, public_key: JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y" }) })
        .execute();
      await trx.insertInto("device_tokens").values({ cafe_id: cafe.cafeId, device_id: seeded.deviceId, token_hash: seeded.tokenHash, expires_at: later }).execute();
      await trx
        .insertInto("pairing_codes")
        .values({
          cafe_id: cafe.cafeId,
          owner_id: cafe.ownerId,
          device_name: "Counter 2",
          lookup_hash: seeded.pairingLookupHash,
          secret_hash: hashOf(randomBytes(32)),
          expires_at: later,
        })
        .execute();
    });
    return seeded;
  }

  async function deviceCounts(key: Parameters<typeof withLookup>[1]): Promise<Record<string, number>> {
    return withLookup(testDb.app.db, key, async (trx) => {
      const counts: Record<string, number> = {};
      for (const table of ["devices", "device_keys", "device_tokens", "pairing_codes", "staff"] as const) {
        const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(trx);
        counts[table] = result.rows[0]?.n ?? -1;
      }
      return counts;
    });
  }

  const none = { devices: 0, device_keys: 0, device_tokens: 0, pairing_codes: 0, staff: 0 };

  beforeAll(async () => {
    deviceA = await seedDevice(cafeA);
    deviceB = await seedDevice(cafeB);
  });

  it("show only the device key with that id", async () => {
    const keys = await withLookup(testDb.app.db, { deviceKeyId: deviceB.keyId.toUpperCase() }, (trx) =>
      trx.selectFrom("device_keys").select(["id", "cafe_id", "device_id"]).execute(),
    );
    expect(keys).toEqual([{ id: deviceB.keyId, cafe_id: deviceB.cafeId, device_id: deviceB.deviceId }]);
    expect(await deviceCounts({ deviceKeyId: deviceB.keyId })).toEqual({ ...none, device_keys: 1 });
    expect(await deviceCounts({ deviceKeyId: randomUUID() })).toEqual(none);
  });

  it("show only the device token or pairing code with that hash", async () => {
    expect(await deviceCounts({ secretHash: deviceA.tokenHash })).toEqual({ ...none, device_tokens: 1 });
    expect(await deviceCounts({ secretHash: deviceA.pairingLookupHash })).toEqual({ ...none, pairing_codes: 1 });
  });

  it("reject a device key id that is not a UUID before touching the database", async () => {
    await expect(withLookup(testDb.app.db, { deviceKeyId: "key-1" }, () => Promise.resolve(1))).rejects.toThrow(TenantContextError);
  });

  it("never let a café change another café's device rows, even holding their key id or hashes", async () => {
    const affected = await withCafe(testDb.app.db, cafeA.cafeId, async (trx) => {
      await sql`SELECT set_config('app.device_key_id', ${deviceB.keyId}, true)`.execute(trx);
      const tokens = await trx.deleteFrom("device_tokens").where("cafe_id", "=", cafeB.cafeId).executeTakeFirst();
      await sql`SELECT set_config('app.secret_hash', ${deviceB.pairingLookupHash.toString("hex")}, true)`.execute(trx);
      const burned = await trx.updateTable("pairing_codes").set({ failed_attempts: 5 }).where("cafe_id", "=", cafeB.cafeId).executeTakeFirst();
      const deleted = await trx.deleteFrom("pairing_codes").where("cafe_id", "=", cafeB.cafeId).executeTakeFirst();
      const revoked = await trx.updateTable("devices").set({ revoked_at: new Date() }).where("id", "=", deviceB.deviceId).executeTakeFirst();
      return { tokens: tokens.numDeletedRows, burned: burned.numUpdatedRows, deleted: deleted.numDeletedRows, revoked: revoked.numUpdatedRows };
    });
    expect(affected).toEqual({ tokens: 0n, burned: 0n, deleted: 0n, revoked: 0n });
  });
});

describe("Apple pass lookups", () => {
  interface SeededPass {
    cafeId: string;
    passId: string;
    tokenHash: Buffer;
  }
  /** One phone (Wallet's device library) with a pass of each café. */
  const deviceHash = hashOf(randomBytes(32));
  let passA: SeededPass;
  let passB: SeededPass;

  async function seedPass(cafe: SeededCafe): Promise<SeededPass> {
    const seeded = { cafeId: cafe.cafeId, passId: randomUUID(), tokenHash: hashOf(randomBytes(32)) };
    const cardId = randomUUID();
    await withCafe(testDb.app.db, cafe.cafeId, async (trx) => {
      await trx.insertInto("cards").values({ id: cardId, cafe_id: cafe.cafeId, web_secret_hash: hashOf(randomBytes(32)), privacy_accepted_at: new Date() }).execute();
      await trx
        .insertInto("apple_passes")
        .values({ id: seeded.passId, cafe_id: cafe.cafeId, card_id: cardId, epoch: 1, auth_token_hash: seeded.tokenHash, layout_version: 1 })
        .execute();
      await trx
        .insertInto("apple_pass_registrations")
        .values({ cafe_id: cafe.cafeId, pass_id: seeded.passId, device_library_hash: deviceHash, push_token: "ab".repeat(32) })
        .execute();
    });
    return seeded;
  }

  async function passCounts(key: Parameters<typeof withLookup>[1]): Promise<Record<string, number>> {
    return withLookup(testDb.app.db, key, async (trx) => {
      const counts: Record<string, number> = {};
      for (const table of ["apple_passes", "apple_pass_registrations", "cards"] as const) {
        const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(trx);
        counts[table] = result.rows[0]?.n ?? -1;
      }
      return counts;
    });
  }

  beforeAll(async () => {
    passA = await seedPass(cafeA);
    passB = await seedPass(cafeB);
  });

  it("show only the pass with that authenticationToken hash, without its registrations or card", async () => {
    const passes = await withLookup(testDb.app.db, { secretHash: passB.tokenHash }, (trx) => trx.selectFrom("apple_passes").select(["id", "cafe_id"]).execute());
    expect(passes).toEqual([{ id: passB.passId, cafe_id: passB.cafeId }]);
    expect(await passCounts({ secretHash: passB.tokenHash })).toEqual({ apple_passes: 1, apple_pass_registrations: 0, cards: 0 });
  });

  it("show a device's registrations and their passes, in every café, and nothing for another device", async () => {
    const passes = await withLookup(testDb.app.db, { secretHash: deviceHash }, (trx) => trx.selectFrom("apple_passes").select("id").orderBy("id").execute());
    expect(passes.map((pass) => pass.id)).toEqual([passA.passId, passB.passId].sort());
    expect(await passCounts({ secretHash: deviceHash })).toEqual({ apple_passes: 2, apple_pass_registrations: 2, cards: 0 });
    expect(await passCounts({ secretHash: hashOf(randomBytes(32)) })).toEqual({ apple_passes: 0, apple_pass_registrations: 0, cards: 0 });
  });

  it("never let a café change another café's passes or registrations, even holding their hashes", async () => {
    const affected = await withCafe(testDb.app.db, cafeA.cafeId, async (trx) => {
      await sql`SELECT set_config('app.secret_hash', ${deviceHash.toString("hex")}, true)`.execute(trx);
      const unregistered = await trx.deleteFrom("apple_pass_registrations").where("cafe_id", "=", cafeB.cafeId).executeTakeFirst();
      const repointed = await trx.updateTable("apple_pass_registrations").set({ push_token: "cd".repeat(32) }).where("cafe_id", "=", cafeB.cafeId).executeTakeFirst();
      await sql`SELECT set_config('app.secret_hash', ${passB.tokenHash.toString("hex")}, true)`.execute(trx);
      const relaid = await trx.updateTable("apple_passes").set({ layout_version: 2 }).where("id", "=", passB.passId).executeTakeFirst();
      return { unregistered: unregistered.numDeletedRows, repointed: repointed.numUpdatedRows, relaid: relaid.numUpdatedRows };
    });
    expect(affected).toEqual({ unregistered: 0n, repointed: 0n, relaid: 0n });
  });
});
