import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContextError, setLookup, useCafe, withCafe, withLookup } from "./database.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

const PERMISSION_DENIED = "42501";
/** An ON DELETE RESTRICT foreign key refusing the delete. */
const RESTRICT_VIOLATION = "23001";

const hash = (value: Buffer | string): Buffer => createHash("sha256").update(value).digest();

let testDb: TestDatabase;
const cafeA = randomUUID();
const cafeB = randomUUID();
const cafeC = randomUUID();

async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** Creates a customer for a phone hash and a card for it in `cafeId`, as signup does. */
async function signUp(cafeId: string, phoneLookup: Buffer, customerId: string = randomUUID(), createCustomer = true): Promise<{ customerId: string; cardId: string; secretHash: Buffer }> {
  const secretHash = hash(randomBytes(32));
  const cardId = await withCafe(testDb.app.db, cafeId, async (trx) => {
    if (createCustomer) {
      await setLookup(trx, { secretHash: phoneLookup });
      await trx
        .insertInto("customers")
        .values({ id: customerId, phone_lookup: phoneLookup, phone_ciphertext: randomBytes(40), phone_key_id: "k1" })
        .execute();
    }
    const card = await trx
      .insertInto("cards")
      .values({ cafe_id: cafeId, customer_id: customerId, web_secret_hash: secretHash, privacy_accepted_at: new Date() })
      .returning("id")
      .executeTakeFirstOrThrow();
    return card.id;
  });
  return { customerId, cardId, secretHash };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  for (const [id, name] of [
    [cafeA, "Café A"],
    [cafeB, "Café B"],
    [cafeC, "Café C"],
  ] as const) {
    await withCafe(testDb.app.db, id, (trx) => trx.insertInto("cafes").values({ id, name }).execute());
  }
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("customers", () => {
  it("are visible to a café only through its own cards (AC 3)", async () => {
    const phone = hash("+96170000001");
    const { customerId } = await signUp(cafeA, phone);
    const seen = async (cafeId: string) => withCafe(testDb.app.db, cafeId, (trx) => trx.selectFrom("customers").select("id").where("id", "=", customerId).execute());
    expect(await seen(cafeA)).toEqual([{ id: customerId }]);
    expect(await seen(cafeB)).toEqual([]);
    const withoutCafe = await sql<{ n: number }>`SELECT count(*)::int AS n FROM customers`.execute(testDb.app.db);
    expect(withoutCafe.rows[0]?.n).toBe(0);
  });

  it("are found by phone hash alone, one at a time", async () => {
    const phone = hash("+96170000002");
    const { customerId } = await signUp(cafeA, phone);
    await signUp(cafeA, hash("+96170000003"));
    const found = await withLookup(testDb.app.db, { secretHash: phone }, (trx) => trx.selectFrom("customers").select("id").execute());
    expect(found).toEqual([{ id: customerId }]);
  });

  it("can only be created for the phone hash the transaction holds", async () => {
    const code = await errorCodeOf(
      withCafe(testDb.app.db, cafeA, async (trx) => {
        await setLookup(trx, { secretHash: hash("+96170000004") });
        await trx.insertInto("customers").values({ phone_lookup: hash("+96170000005"), phone_ciphertext: randomBytes(40), phone_key_id: "k1" }).execute();
      }),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it("cannot be deleted while any café still has a card for them, and can once none does", async () => {
    const phone = hash("+96170000006");
    const { customerId, cardId } = await signUp(cafeA, phone);
    const cardB = await signUp(cafeB, phone, customerId, false);
    const deleteCustomer = () =>
      withCafe(testDb.app.db, cafeA, async (trx) => {
        await setLookup(trx, { customerId });
        return trx.deleteFrom("customers").where("id", "=", customerId).executeTakeFirst();
      });

    await withCafe(testDb.app.db, cafeA, (trx) => trx.deleteFrom("cards").where("id", "=", cardId).execute());
    // Café A no longer has a card, but café B does: the foreign key refuses whatever café A's view shows.
    expect(await errorCodeOf(deleteCustomer())).toBe(RESTRICT_VIOLATION);
    await withCafe(testDb.app.db, cafeB, (trx) => trx.deleteFrom("cards").where("id", "=", cardB.cardId).execute());
    expect((await deleteCustomer()).numDeletedRows).toBe(1n);
  });

  it("cannot be deleted without the customer id in the transaction", async () => {
    const { customerId } = await signUp(cafeC, hash("+96170000007"));
    const deleted = await withCafe(testDb.app.db, cafeC, (trx) => trx.deleteFrom("customers").where("id", "=", customerId).executeTakeFirst());
    expect(deleted.numDeletedRows).toBe(0n);
  });
});

describe("cards", () => {
  it("are found by their web secret hash or recovery email hash, one at a time", async () => {
    const { secretHash, cardId } = await signUp(cafeA, hash("+96170000008"));
    const emailLookup = hash("rana@example.com");
    await withCafe(testDb.app.db, cafeA, (trx) => trx.updateTable("cards").set({ email: "rana@example.com", email_lookup: emailLookup }).where("id", "=", cardId).execute());
    for (const key of [secretHash, emailLookup]) {
      const found = await withLookup(testDb.app.db, { secretHash: key }, (trx) => trx.selectFrom("cards").select(["id", "cafe_id"]).execute());
      expect(found).toEqual([{ id: cardId, cafe_id: cafeA }]);
    }
  });

  it("can be updated across a customer's cafés by switching café inside one transaction", async () => {
    const phone = hash("+96170000009");
    const first = await signUp(cafeA, phone);
    const second = await signUp(cafeB, phone, first.customerId, false);
    await withCafe(testDb.app.db, cafeA, async (trx) => {
      await trx.updateTable("cards").set({ epoch: 2 }).where("id", "=", first.cardId).execute();
      await useCafe(trx, cafeB);
      // Under café B, café A's card is out of reach and café B's is in reach.
      expect((await trx.updateTable("cards").set({ epoch: 3 }).where("id", "=", first.cardId).executeTakeFirst()).numUpdatedRows).toBe(0n);
      expect((await trx.updateTable("cards").set({ epoch: 2 }).where("id", "=", second.cardId).executeTakeFirst()).numUpdatedRows).toBe(1n);
    });
    await expect(withCafe(testDb.app.db, cafeA, (trx) => useCafe(trx, "not-a-uuid"))).rejects.toThrow(TenantContextError);
  });
});

describe("customer recovery tokens", () => {
  it("are created only for the email hash the transaction holds, and read or used only by token or email hash", async () => {
    const emailLookup = hash("sami@example.com");
    const tokenHash = hash(randomBytes(32));
    await withLookup(
      testDb.app.db,
      { secretHash: emailLookup },
      (trx) => trx.insertInto("customer_recovery_tokens").values({ email_lookup: emailLookup, token_hash: tokenHash, expires_at: new Date(Date.now() + 60_000) }).execute(),
      "read write",
    );
    const forged = await errorCodeOf(
      withLookup(
        testDb.app.db,
        { secretHash: hash("other@example.com") },
        (trx) => trx.insertInto("customer_recovery_tokens").values({ email_lookup: emailLookup, token_hash: hash(randomBytes(32)), expires_at: new Date() }).execute(),
        "read write",
      ),
    );
    expect(forged).toBe(PERMISSION_DENIED);
    const count = (key: Buffer) =>
      withLookup(testDb.app.db, { secretHash: key }, async (trx) => (await trx.selectFrom("customer_recovery_tokens").select("id").execute()).length);
    expect(await count(tokenHash)).toBe(1);
    expect(await count(emailLookup)).toBe(1);
    expect(await count(hash(randomBytes(32)))).toBe(0);
    const used = await withLookup(testDb.app.db, { secretHash: tokenHash }, (trx) => trx.deleteFrom("customer_recovery_tokens").executeTakeFirst(), "read write");
    expect(used.numDeletedRows).toBe(1n);
  });
});

describe("café join codes", () => {
  it("find their café, and only it", async () => {
    const code = await withCafe(testDb.app.db, cafeB, (trx) => trx.selectFrom("cafes").select("join_code").executeTakeFirstOrThrow());
    expect(code.join_code).toMatch(/^[0-9a-f]{32}$/);
    const found = await withLookup(testDb.app.db, { secretHash: hash(code.join_code) }, (trx) => trx.selectFrom("cafes").select("id").execute());
    expect(found).toEqual([{ id: cafeB }]);
  });
});
