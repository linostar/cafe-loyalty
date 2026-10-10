import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContextError, withCafe, withLookup, withOperator } from "./database.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

const PERMISSION_DENIED = "42501";

let testDb: TestDatabase;
const cafeA = randomUUID();
const cafeB = randomUUID();

async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** An operator as create-operator makes one (by its email), with one session; returns their ids and the session hash. */
async function createOperator(): Promise<{ operatorId: string; email: string; tokenHash: Buffer }> {
  const email = `operator-${randomUUID()}@example.com`;
  const operatorId = await withLookup(
    testDb.app.db,
    { operatorEmail: email },
    async (trx) => (await trx.insertInto("operators").values({ email, password_hash: "fake-hash" }).returning("id").executeTakeFirstOrThrow()).id,
    "read write",
  );
  const tokenHash = createHash("sha256").update(randomBytes(32)).digest();
  await withOperator(testDb.app.db, operatorId, (trx) =>
    trx.insertInto("operator_sessions").values({ operator_id: operatorId, token_hash: tokenHash, expires_at: new Date(Date.now() + 60_000) }).execute(),
  );
  return { operatorId, email, tokenHash };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  for (const [id, name] of [
    [cafeA, "Café A"],
    [cafeB, "Café B"],
  ] as const) {
    await withCafe(testDb.app.db, id, (trx) => trx.insertInto("cafes").values({ id, name }).execute());
  }
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("operators (AC 39)", () => {
  it("are visible only by their email or as themselves, never to a café", async () => {
    const first = await createOperator();
    const second = await createOperator();
    const byEmail = await withLookup(testDb.app.db, { operatorEmail: first.email }, (trx) => trx.selectFrom("operators").select("id").execute());
    expect(byEmail).toEqual([{ id: first.operatorId }]);
    expect(await withOperator(testDb.app.db, second.operatorId, (trx) => trx.selectFrom("operators").select("id").execute())).toEqual([{ id: second.operatorId }]);
    expect(await withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("operators").select("id").execute())).toEqual([]);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM operators`.execute(testDb.app.db)).rows).toEqual([{ n: 0 }]);
  });

  it("can only be created by their own email and only change their own password", async () => {
    const { operatorId } = await createOperator();
    const other = await createOperator();
    // Another email than the one set is refused.
    expect(
      await errorCodeOf(
        withLookup(testDb.app.db, { operatorEmail: "someone@example.com" }, (trx) => trx.insertInto("operators").values({ email: "other@example.com", password_hash: "x" }).execute(), "read write"),
      ),
    ).toBe(PERMISSION_DENIED);
    const changed = await withOperator(testDb.app.db, operatorId, (trx) => trx.updateTable("operators").set({ password_hash: "new-hash" }).where("id", "=", other.operatorId).executeTakeFirst());
    expect(changed.numUpdatedRows).toBe(0n);
    // The email cannot change at all.
    expect(await errorCodeOf(sql`UPDATE operators SET email = 'x@example.com'`.execute(testDb.app.db))).toBe(PERMISSION_DENIED);
    await expect(withOperator(testDb.app.db, "not-a-uuid", () => Promise.resolve())).rejects.toBeInstanceOf(TenantContextError);
  });

  it("find a session by its hash, and write only their own sessions", async () => {
    const first = await createOperator();
    const second = await createOperator();
    const found = await withLookup(testDb.app.db, { secretHash: first.tokenHash }, (trx) => trx.selectFrom("operator_sessions").select("operator_id").execute());
    expect(found).toEqual([{ operator_id: first.operatorId }]);
    // Writing another operator's session is refused, and deleting it does nothing.
    expect(
      await errorCodeOf(
        withOperator(testDb.app.db, first.operatorId, (trx) =>
          trx.insertInto("operator_sessions").values({ operator_id: second.operatorId, token_hash: randomBytes(32), expires_at: new Date(Date.now() + 60_000) }).execute(),
        ),
      ),
    ).toBe(PERMISSION_DENIED);
    const deleted = await withOperator(testDb.app.db, first.operatorId, (trx) => trx.deleteFrom("operator_sessions").where("operator_id", "=", second.operatorId).executeTakeFirst());
    expect(deleted.numDeletedRows).toBe(0n);
    expect(await withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("operator_sessions").select("id").execute())).toEqual([]);
  });

  it("list every café's id, and no more, through cafes_for_operator", async () => {
    const { rows } = await sql<{ cafe_id: string }>`SELECT cafe_id FROM cafes_for_operator()`.execute(testDb.app.db);
    expect(rows.map((row) => row.cafe_id)).toEqual(expect.arrayContaining([cafeA, cafeB]));
    // Without withCafe, the cafés themselves stay hidden.
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM cafes`.execute(testDb.app.db)).rows).toEqual([{ n: 0 }]);
  });

  it("record a café's plan and payments inside that café only", async () => {
    const { operatorId } = await createOperator();
    await withCafe(testDb.app.db, cafeA, async (trx) => {
      await trx.updateTable("cafes").set({ plan: "suspended" }).where("id", "=", cafeA).execute();
      await trx.insertInto("cafe_payments").values({ cafe_id: cafeA, amount_cents: 2500, paid_on: "2026-10-01", method: "whish", operator_id: operatorId }).execute();
    });
    expect(await withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("cafes").select("plan").executeTakeFirst())).toEqual({ plan: "suspended" });
    expect(await withCafe(testDb.app.db, cafeB, (trx) => trx.selectFrom("cafes").select("plan").executeTakeFirst())).toEqual({ plan: "pilot" });
    expect(await withCafe(testDb.app.db, cafeB, (trx) => trx.selectFrom("cafe_payments").select("id").execute())).toEqual([]);
    // Payments are never changed or deleted.
    expect(await errorCodeOf(withCafe(testDb.app.db, cafeA, (trx) => trx.deleteFrom("cafe_payments").execute()))).toBe(PERMISSION_DENIED);
    expect(await errorCodeOf(withCafe(testDb.app.db, cafeA, (trx) => trx.updateTable("cafes").set({ plan: "free" as "pilot" }).execute()))).toBe("23514");
  });
});
