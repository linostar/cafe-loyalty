import { randomBytes, randomUUID } from "node:crypto";
import type { Updateable } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCafe, withLookup } from "./database.js";
import type { CafesTable } from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

let testDb: TestDatabase;
const cafeA = randomUUID();
const cafeB = randomUUID();

/** A café with one card whose epoch moved on once: an Apple and a Google pass at epoch 1 (voided) and at epoch 2 (current). */
async function seed(cafeId: string): Promise<void> {
  await withCafe(testDb.app.db, cafeId, async (trx) => {
    await trx.insertInto("cafes").values({ id: cafeId, name: "Café" }).execute();
    const cardId = randomUUID();
    await trx.insertInto("cards").values({ id: cardId, cafe_id: cafeId, web_secret_hash: randomBytes(32), privacy_accepted_at: new Date() }).execute();
    for (const epoch of [1, 2]) {
      if (epoch === 2) {
        await trx.updateTable("cards").set({ epoch: 2 }).where("id", "=", cardId).execute();
      }
      await trx.insertInto("apple_passes").values({ cafe_id: cafeId, card_id: cardId, epoch, auth_token_hash: randomBytes(32), layout_version: 1 }).execute();
      await trx.insertInto("google_passes").values({ cafe_id: cafeId, card_id: cardId, epoch }).execute();
    }
  });
}

/** Each pass's change marker, by wallet and epoch. */
async function markers(cafeId: string): Promise<Record<string, string>> {
  return withCafe(testDb.app.db, cafeId, async (trx) => {
    const apple = await trx.selectFrom("apple_passes").select(["epoch", "updated_xid"]).execute();
    const google = await trx.selectFrom("google_passes").select(["epoch", "updated_xid"]).execute();
    const entries: [string, string][] = [
      ...apple.map((pass): [string, string] => [`apple-${String(pass.epoch)}`, pass.updated_xid]),
      ...google.map((pass): [string, string] => [`google-${String(pass.epoch)}`, pass.updated_xid]),
    ];
    return Object.fromEntries(entries);
  });
}

/** Which passes of each café a change marked: the current ones of café A, or none. */
async function marked(change: () => Promise<unknown>): Promise<{ a: string[]; b: string[] }> {
  const before = { a: await markers(cafeA), b: await markers(cafeB) };
  await change();
  const after = { a: await markers(cafeA), b: await markers(cafeB) };
  const moved = (was: Record<string, string>, now: Record<string, string>) => Object.keys(now).filter((key) => now[key] !== was[key]).sort();
  return { a: moved(before.a, after.a), b: moved(before.b, after.b) };
}

const CURRENT = ["apple-2", "google-2"];
const NONE = { a: [], b: [] };

beforeAll(async () => {
  testDb = await createTestDatabase();
  await seed(cafeA);
  await seed(cafeB);
});

afterAll(async () => {
  await testDb.cleanup();
});

const update = (values: Updateable<CafesTable>) => () =>
  withCafe(testDb.app.db, cafeA, (trx) => trx.updateTable("cafes").set(values).where("id", "=", cafeA).execute());

describe("a café's branding", () => {
  it("defaults the card colours to the espresso every card had", async () => {
    const cafe = await withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("cafes").select(["card_background", "card_foreground", "card_label"]).executeTakeFirstOrThrow());
    expect(cafe).toEqual({ card_background: "#4a2c2a", card_foreground: "#ffffff", card_label: "#ebd6be" });
  });

  it("refuses a colour that is not lowercase #rrggbb", async () => {
    await expect(update({ card_background: "#ABCDEF" })()).rejects.toMatchObject({ code: "23514" });
    await expect(update({ card_label: "red" })()).rejects.toMatchObject({ code: "23514" });
  });

  it("marks every current pass of the café on a new name or colour, never a voided one or another café's", async () => {
    expect(await marked(update({ name: "Café Renamed" }))).toEqual({ a: CURRENT, b: [] });
    expect(await marked(update({ card_background: "#123456" }))).toEqual({ a: CURRENT, b: [] });
    expect(await marked(update({ card_foreground: "#fefefe", card_label: "#eeeeee" }))).toEqual({ a: CURRENT, b: [] });
  });

  it("leaves the passes alone on any other change, the same name again, or the worker's Google class record", async () => {
    expect(await marked(update({ min_margin_percent: 35 }))).toEqual(NONE);
    expect(await marked(update({ name: "Café Renamed" }))).toEqual(NONE);
    expect(await marked(update({ google_class_hash: randomBytes(32) }))).toEqual(NONE);
  });

  it("marks them when a logo is added, replaced or removed, but not when the same logo is saved again", async () => {
    const hash = randomBytes(32);
    const logo = { hash, square: randomBytes(8), apple_1x: randomBytes(8), apple_2x: randomBytes(8), apple_3x: randomBytes(8) };
    const save = (values: typeof logo) => () =>
      withCafe(testDb.app.db, cafeA, (trx) =>
        trx
          .insertInto("cafe_logos")
          .values({ cafe_id: cafeA, ...values })
          .onConflict((conflict) => conflict.column("cafe_id").doUpdateSet(values))
          .execute(),
      );
    expect(await marked(save(logo))).toEqual({ a: CURRENT, b: [] });
    expect(await marked(save(logo))).toEqual(NONE);
    expect(await marked(save({ ...logo, hash: randomBytes(32) }))).toEqual({ a: CURRENT, b: [] });
    expect(await marked(() => withCafe(testDb.app.db, cafeA, (trx) => trx.deleteFrom("cafe_logos").execute()))).toEqual({ a: CURRENT, b: [] });
  });

  it("finds a logo by its hash with no café set, and nothing by another hash", async () => {
    const hash = randomBytes(32);
    await withCafe(testDb.app.db, cafeB, (trx) =>
      trx.insertInto("cafe_logos").values({ cafe_id: cafeB, hash, square: Buffer.from("png"), apple_1x: randomBytes(8), apple_2x: randomBytes(8), apple_3x: randomBytes(8) }).execute(),
    );
    const found = await withLookup(testDb.app.db, { secretHash: hash }, (trx) => trx.selectFrom("cafe_logos").select(["cafe_id", "square"]).execute());
    expect(found).toEqual([{ cafe_id: cafeB, square: Buffer.from("png") }]);
    const other = await withLookup(testDb.app.db, { secretHash: randomBytes(32) }, (trx) => trx.selectFrom("cafe_logos").select("cafe_id").execute());
    expect(other).toEqual([]);
  });
});
