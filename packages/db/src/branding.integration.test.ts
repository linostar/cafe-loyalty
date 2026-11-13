import { randomBytes, randomUUID } from "node:crypto";
import type { Updateable } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCafeBranding, removeCafeLogo, removeCafePicture, saveCafeLogo, saveCafePicture, type CafeLogoImages, type CafePictureImages } from "./branding.js";
import { withCafe, withLookup } from "./database.js";
import type { CafesTable } from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

let testDb: TestDatabase;
const cafeA = randomUUID();
const cafeB = randomUUID();

/** Each card's name in the markers, by its id. */
const cardNames = new Map<string, string>();

/**
 * A café with two cards whose epochs moved on once: each with an Apple and a Google pass at epoch 1 (voided) and at
 * epoch 2 (current).
 */
async function seed(cafeId: string): Promise<void> {
  await withCafe(testDb.app.db, cafeId, async (trx) => {
    await trx.insertInto("cafes").values({ id: cafeId, name: "Café" }).execute();
    for (const name of ["x", "y"]) {
      const cardId = randomUUID();
      cardNames.set(cardId, name);
      await trx.insertInto("cards").values({ id: cardId, cafe_id: cafeId, web_secret_hash: randomBytes(32), privacy_accepted_at: new Date() }).execute();
      for (const epoch of [1, 2]) {
        if (epoch === 2) {
          await trx.updateTable("cards").set({ epoch: 2 }).where("id", "=", cardId).execute();
        }
        await trx.insertInto("apple_passes").values({ cafe_id: cafeId, card_id: cardId, epoch, auth_token_hash: randomBytes(32), layout_version: 1 }).execute();
        await trx.insertInto("google_passes").values({ cafe_id: cafeId, card_id: cardId, epoch }).execute();
      }
    }
  });
}

/**
 * Each pass's change marker, by wallet, card and epoch; a current Google pass of either card is `google-current`, since
 * a change of the class marks just one of them, whichever (a change of the stamp picture marks both).
 */
async function markers(cafeId: string): Promise<Record<string, string>> {
  return withCafe(testDb.app.db, cafeId, async (trx) => {
    const apple = await trx.selectFrom("apple_passes").select(["card_id", "epoch", "updated_xid"]).execute();
    const google = await trx.selectFrom("google_passes").select(["card_id", "epoch", "updated_xid"]).execute();
    const key = (wallet: string, pass: { card_id: string; epoch: number }) => `${wallet}-${cardNames.get(pass.card_id) ?? "?"}-${String(pass.epoch)}`;
    const entries: [string, string][] = [
      ...apple.map((pass): [string, string] => [key("apple", pass), pass.updated_xid]),
      ...google.map((pass): [string, string] => [key("google", pass), pass.updated_xid]),
    ];
    return Object.fromEntries(entries);
  });
}

/** Which passes of each café a change marked: the current ones of café A, or none. */
async function marked(change: () => Promise<unknown>): Promise<{ a: string[]; b: string[] }> {
  const before = { a: await markers(cafeA), b: await markers(cafeB) };
  await change();
  const after = { a: await markers(cafeA), b: await markers(cafeB) };
  const moved = (was: Record<string, string>, now: Record<string, string>) =>
    Object.keys(now)
      .filter((key) => now[key] !== was[key])
      .map((key) => (/^google-.-2$/.test(key) ? "google-current" : key))
      .sort();
  return { a: moved(before.a, after.a), b: moved(before.b, after.b) };
}

/** Every current Apple pass, and one current Google pass (its job writes the café's class, which shows the name, logo and background). */
const CURRENT = ["apple-x-2", "apple-y-2", "google-current"];
/** Every current pass of both wallets: each Google object's stamp picture shows the shape, background and text colour. */
const EVERY = ["apple-x-2", "apple-y-2", "google-current", "google-current"];
const NONE = { a: [], b: [] };

/** A logo's images (random bytes: the database does not decode them). */
const images = (): CafeLogoImages => ({ hash: randomBytes(32), square: randomBytes(8), apple1x: randomBytes(8), apple2x: randomBytes(8), apple3x: randomBytes(8), stampMask: randomBytes(8), stampMaskHash: randomBytes(32), stampMaskVersion: 2 });

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
    expect(await marked(update({ card_label: "#eeeeee" }))).toEqual({ a: CURRENT, b: [] });
    // The colours a stamp picture shows: every Google object too.
    expect(await marked(update({ card_background: "#123456" }))).toEqual({ a: EVERY, b: [] });
    expect(await marked(update({ card_foreground: "#fefefe", card_label: "#dddddd" }))).toEqual({ a: EVERY, b: [] });
  });

  it("starts every café on the circle and marks every current pass on a new stamp shape, refusing an unknown one", async () => {
    const shape = () => withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("cafes").select("stamp_shape").executeTakeFirstOrThrow());
    expect(await shape()).toEqual({ stamp_shape: "circle" });
    expect(await marked(update({ stamp_shape: "cup" }))).toEqual({ a: EVERY, b: [] });
    expect(await marked(update({ stamp_shape: "cup" }))).toEqual(NONE);
    // @ts-expect-error: not a shape, as only SQL could send it.
    await expect(update({ stamp_shape: "star" })()).rejects.toMatchObject({ code: "23514" });
  });

  it("marks every current pass (and the Google class's pass) when the review link is set, changed or cleared, not when saved again", async () => {
    expect(await marked(update({ google_review_url: "https://g.page/r/fake-review-link/review" }))).toEqual({ a: CURRENT, b: [] });
    expect(await marked(update({ google_review_url: "https://g.page/r/fake-review-link/review" }))).toEqual(NONE);
    expect(await marked(update({ google_review_url: "https://g.page/r/other-fake-link/review" }))).toEqual({ a: CURRENT, b: [] });
    expect(await marked(update({ google_review_url: null }))).toEqual({ a: CURRENT, b: [] });
  });

  it("leaves the passes alone on any other change, the same name again, or the worker's Google class record", async () => {
    expect(await marked(update({ min_margin_percent: 35 }))).toEqual(NONE);
    expect(await marked(update({ name: "Café Renamed" }))).toEqual(NONE);
    expect(await marked(update({ google_class_hash: randomBytes(32) }))).toEqual(NONE);
  });

  it("marks them when a logo is added, replaced or removed, but not when the same logo is saved again", async () => {
    const logo = images();
    const save = (values: CafeLogoImages) => () => withCafe(testDb.app.db, cafeA, (trx) => saveCafeLogo(trx, cafeA, values));
    const remove = () => withCafe(testDb.app.db, cafeA, (trx) => removeCafeLogo(trx, cafeA));
    expect(await marked(save(logo))).toEqual({ a: CURRENT, b: [] });
    expect(await marked(save(logo))).toEqual(NONE);
    expect(await marked(save({ ...logo, hash: randomBytes(32) }))).toEqual({ a: CURRENT, b: [] });
    expect(await marked(remove)).toEqual({ a: CURRENT, b: [] });
    // Removed already: nothing changes.
    expect(await marked(remove)).toEqual(NONE);
  });

  it("keeps the logo a change replaced or removed as the previous one, until the next change", async () => {
    const first = images();
    const second = images();
    const third = images();
    const row = () => withCafe(testDb.app.db, cafeB, (trx) => trx.selectFrom("cafe_logos").select(["hash", "previous_hash", "previous_square"]).executeTakeFirstOrThrow());
    await withCafe(testDb.app.db, cafeB, (trx) => saveCafeLogo(trx, cafeB, first));
    expect(await row()).toEqual({ hash: first.hash, previous_hash: null, previous_square: null });
    await withCafe(testDb.app.db, cafeB, (trx) => saveCafeLogo(trx, cafeB, second));
    expect(await row()).toEqual({ hash: second.hash, previous_hash: first.hash, previous_square: first.square });
    // The same logo again is no change.
    await withCafe(testDb.app.db, cafeB, (trx) => saveCafeLogo(trx, cafeB, second));
    expect(await row()).toEqual({ hash: second.hash, previous_hash: first.hash, previous_square: first.square });
    expect(await withCafe(testDb.app.db, cafeB, (trx) => removeCafeLogo(trx, cafeB))).toEqual(second.hash);
    expect(await row()).toEqual({ hash: null, previous_hash: second.hash, previous_square: second.square });
    expect(await withCafe(testDb.app.db, cafeB, (trx) => removeCafeLogo(trx, cafeB))).toBeUndefined();
    // A logo after none: nothing was shown before it.
    await withCafe(testDb.app.db, cafeB, (trx) => saveCafeLogo(trx, cafeB, third));
    expect(await row()).toEqual({ hash: third.hash, previous_hash: null, previous_square: null });
    await withCafe(testDb.app.db, cafeB, (trx) => trx.deleteFrom("cafe_logos").execute());
  });

  it("draws \"From logo\" from the current logo: every pass marked on a new one, and back to the circle without one", async () => {
    const shape = async () => (await withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("cafes").select("stamp_shape").executeTakeFirstOrThrow())).stamp_shape;
    const mask = async () => (await withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("cafe_logos").select("stamp_mask").executeTakeFirstOrThrow())).stamp_mask;
    const save = (values: CafeLogoImages) => () => withCafe(testDb.app.db, cafeA, (trx) => saveCafeLogo(trx, cafeA, values));
    const remove = () => withCafe(testDb.app.db, cafeA, (trx) => removeCafeLogo(trx, cafeA));
    await save(images())();
    expect(await marked(update({ stamp_shape: "logo" }))).toEqual({ a: EVERY, b: [] });
    // A new logo is a new silhouette on every Google object's stamp picture, not only the class's pass.
    const next = images();
    expect(await marked(save(next))).toEqual({ a: EVERY, b: [] });
    expect(await mask()).toEqual(next.stampMask);
    // A recoloured logo: a new logo with the same silhouette keeps it, and "From logo" with it; the pictures name the new logo.
    const recoloured = { ...images(), stampMask: next.stampMask };
    expect(await marked(save(recoloured))).toEqual({ a: EVERY, b: [] });
    expect(await mask()).toEqual(next.stampMask);
    expect(await shape()).toBe("logo");
    // A silhouette cut again (the server's start-up re-cut: the same logo, a new silhouette) changes every pass's stamps.
    const recut = () => withCafe(testDb.app.db, cafeA, (trx) => trx.updateTable("cafe_logos").set({ stamp_mask: randomBytes(8), stamp_mask_hash: randomBytes(32), stamp_mask_version: 3 }).execute());
    expect(await marked(recut)).toEqual({ a: EVERY, b: [] });
    expect(await shape()).toBe("logo");
    // A silhouette written without its hash (a release from before 0039) drops the hash and version it replaced, so the
    // next start-up cuts it again; the café stays on "From logo".
    await withCafe(testDb.app.db, cafeA, (trx) => trx.updateTable("cafe_logos").set({ stamp_mask: randomBytes(8) }).execute());
    expect(await withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("cafe_logos").select(["stamp_mask_hash", "stamp_mask_version"]).executeTakeFirstOrThrow())).toEqual({
      stamp_mask_hash: null,
      stamp_mask_version: null,
    });
    expect(await shape()).toBe("logo");
    // A logo saved without a silhouette (a release from before 0037) drops the old one, and "From logo" with it.
    const older = () =>
      withCafe(testDb.app.db, cafeA, (trx) =>
        trx.updateTable("cafe_logos").set({ hash: randomBytes(32), square: randomBytes(8), apple_1x: randomBytes(8), apple_2x: randomBytes(8), apple_3x: randomBytes(8) }).execute(),
      );
    expect(await marked(older)).toEqual({ a: EVERY, b: [] });
    expect(await mask()).toBeNull();
    expect(await shape()).toBe("circle");
    // Removing the logo goes back to the circle too.
    await save(images())();
    await update({ stamp_shape: "logo" })();
    expect(await marked(remove)).toEqual({ a: EVERY, b: [] });
    expect(await shape()).toBe("circle");
    // Leaves café A without a logo for the tests after it.
    await withCafe(testDb.app.db, cafeA, (trx) => trx.deleteFrom("cafe_logos").execute());
  });

  it("draws \"From picture\" from the café's own picture, never its logo: every pass marked on a new one, and back to the circle without one", async () => {
    const shape = async () => (await withCafe(testDb.app.db, cafeA, (trx) => trx.selectFrom("cafes").select("stamp_shape").executeTakeFirstOrThrow())).stamp_shape;
    const branding = () => withCafe(testDb.app.db, cafeA, (trx) => loadCafeBranding(trx, cafeA));
    const picture = (): CafePictureImages => ({ square: randomBytes(8), stampMask: randomBytes(8), stampMaskHash: randomBytes(32), stampMaskVersion: 2 });
    const save = (values: CafePictureImages) => () => withCafe(testDb.app.db, cafeA, (trx) => saveCafePicture(trx, cafeA, values));
    const remove = () => withCafe(testDb.app.db, cafeA, (trx) => removeCafePicture(trx, cafeA));
    const first = picture();
    // A first picture shows on no card until the café picks it.
    expect(await marked(save(first))).toEqual(NONE);
    expect(await marked(update({ stamp_shape: "picture" }))).toEqual({ a: EVERY, b: [] });
    expect(await branding()).toMatchObject({ stampShape: "picture", logoHash: null, stampMaskHash: first.stampMaskHash });
    // A logo is the card's logo (its class's pass is marked), not the stamps': they keep the picture's silhouette.
    const logo = images();
    expect(await marked(() => withCafe(testDb.app.db, cafeA, (trx) => saveCafeLogo(trx, cafeA, logo)))).toEqual({ a: CURRENT, b: [] });
    expect(await branding()).toMatchObject({ stampShape: "picture", logoHash: logo.hash, stampMaskHash: first.stampMaskHash });
    expect(await marked(() => withCafe(testDb.app.db, cafeA, (trx) => removeCafeLogo(trx, cafeA)))).toEqual({ a: CURRENT, b: [] });
    expect(await shape()).toBe("picture");
    // A new picture (a replacement, or a re-cut) changes every pass's stamps; the same one again changes nothing.
    const next = picture();
    expect(await marked(save(next))).toEqual({ a: EVERY, b: [] });
    expect(await marked(save(next))).toEqual(NONE);
    expect((await branding()).stampMaskHash).toEqual(next.stampMaskHash);
    // Found by its silhouette's hash with no café set (its public address), and by nothing else.
    const lookup = (hash: Buffer) => withLookup(testDb.app.db, { secretHash: hash }, (trx) => trx.selectFrom("cafe_pictures").select("cafe_id").execute());
    expect(await lookup(next.stampMaskHash)).toEqual([{ cafe_id: cafeA }]);
    expect(await lookup(first.stampMaskHash)).toEqual([]);
    // Removing it goes back to the circle; removed already, nothing changes.
    expect(await marked(async () => {
      expect(await remove()).toEqual(next.stampMaskHash);
    })).toEqual({ a: EVERY, b: [] });
    expect(await shape()).toBe("circle");
    expect(await marked(async () => {
      expect(await remove()).toBeUndefined();
    })).toEqual(NONE);
    // A picture removed while another shape is picked leaves that shape.
    await save(picture())();
    await update({ stamp_shape: "cup" })();
    expect(await marked(remove)).toEqual(NONE);
    expect(await shape()).toBe("cup");
    await update({ stamp_shape: "circle" })();
    await withCafe(testDb.app.db, cafeA, (trx) => trx.deleteFrom("cafe_logos").execute());
  });

  it("finds a logo by its hash or its previous hash with no café set, and nothing by another hash", async () => {
    const first = { ...images(), square: Buffer.from("first") };
    const second = { ...images(), square: Buffer.from("second") };
    await withCafe(testDb.app.db, cafeB, (trx) => saveCafeLogo(trx, cafeB, first));
    await withCafe(testDb.app.db, cafeB, (trx) => saveCafeLogo(trx, cafeB, second));
    const lookup = (hash: Buffer) => withLookup(testDb.app.db, { secretHash: hash }, (trx) => trx.selectFrom("cafe_logos").select(["cafe_id", "square", "previous_square"]).execute());
    expect(await lookup(second.hash)).toEqual([{ cafe_id: cafeB, square: Buffer.from("second"), previous_square: Buffer.from("first") }]);
    expect(await lookup(first.hash)).toEqual([{ cafe_id: cafeB, square: Buffer.from("second"), previous_square: Buffer.from("first") }]);
    expect(await lookup(randomBytes(32))).toEqual([]);
  });
});
