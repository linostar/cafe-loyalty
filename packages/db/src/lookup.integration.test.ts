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
