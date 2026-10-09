import { randomBytes, randomUUID } from "node:crypto";
import { withCafe } from "@cafe-loyalty/db";
import { COUNTER_BUILT_AT_HEADER, deviceCatalogSchema, redemptionSchema, syncResponseSchema } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { signCardQr } from "./customer-crypto.js";
import { DAILY_STAMP_CAP } from "./stamping.js";
import { TEST_SECRETS, signedEvent, useApiHarness, withBearer, withCookie, type PairedDevice } from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, pairDevice, auditActions, issueCard } = context;

const MINUTE = 60 * 1000;

async function cafeApp() {
  const h = await harness();
  const owner = await signUp(h.app);
  const as = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload: Record<string, unknown> = {}) =>
    h.app.inject({ method, url, headers: withCookie(owner.session), ...(method === "GET" ? {} : { payload }) });
  await as("PUT", "/api/cafe/program", { stampsRequired: 3, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" });
  const addType = async (nameEn: string, stampsEarned: number, active = true) => {
    const setup = (await as("POST", "/api/cafe/order-types", { nameAr: nameEn, nameEn, priceCents: 300, costCents: 90, stampsEarned, active })).json<{
      orderTypes: { id: string; nameEn: string }[];
    }>();
    return setup.orderTypes.find((type) => type.nameEn === nameEn)?.id ?? "missing";
  };
  const coffee = await addType("Coffee", 1);
  const cake = await addType("Cake", 0);
  const staffId = (await as("POST", "/api/staff", { name: "Rami", pin: "482913" })).json<{ staff: { id: string }[] }>().staff[0]?.id ?? "missing";
  const device = await pairDevice(h.app, owner);
  return { ...h, owner, as, addType, coffee, cake, staffId, device };
}

type App = Awaited<ReturnType<typeof cafeApp>>;
let sequence = 0;

function visit(app: App, card: { kind: "qr"; token: string } | { kind: "phone"; phone: string }, options: { at?: Date; items?: unknown[]; device?: PairedDevice } = {}) {
  sequence += 1;
  const items = options.items ?? [
    { orderTypeId: app.coffee, quantity: 2, unitPriceCents: 300, unitCostCents: 90, catalogVersion: 1 },
    { orderTypeId: app.cake, quantity: 1, unitPriceCents: 450, unitCostCents: 150, catalogVersion: 1 },
  ];
  const totalCents = (items as { quantity: number; unitPriceCents: number }[]).reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  return signedEvent(options.device ?? app.device, {
    eventId: randomUUID(),
    staffId: app.staffId,
    sequence,
    schemaVersion: 1,
    type: "visit.recorded",
    occurredAt: (options.at ?? new Date()).toISOString(),
    payload: { card, items, totalCents },
  });
}

async function sync(app: App, events: unknown[], token = app.device.accessToken) {
  const response = await app.app.inject({ method: "POST", url: "/api/device/sync", headers: withBearer(token), payload: { events } });
  expect(response.statusCode).toBe(200);
  return syncResponseSchema.parse(response.json()).results.map(({ status, code }) => ({ status, code }));
}

async function stampsOf(cardId: string): Promise<number> {
  const { rows } = await context.admin.query<{ stamps: number }>("SELECT stamps FROM app.cards WHERE id = $1", [cardId]);
  return rows[0]?.stamps ?? -1;
}

async function visitsOf(cardId: string) {
  const { rows } = await context.admin.query<{ outcome: string; stamps_earned: number; stamps_added: number }>(
    "SELECT outcome, stamps_earned, stamps_added FROM app.visits WHERE card_id = $1 ORDER BY occurred_at",
    [cardId],
  );
  return rows;
}

describe("stamping", () => {
  it("adds the stamps of the items that earn them, keeps the prices as sent and audits it (AC 30, 32)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    expect(await sync(app, [await visit(app, { kind: "qr", token: card.qr })])).toEqual([{ status: "applied", code: "OK" }]);
    expect(await stampsOf(card.cardId)).toBe(2);
    const { rows: items } = await context.admin.query(
      "SELECT line, quantity, unit_price_cents, unit_cost_cents, catalog_version, stamps_each FROM app.visit_items i JOIN app.visits v ON v.id = i.visit_id WHERE v.card_id = $1 ORDER BY line",
      [card.cardId],
    );
    expect(items).toEqual([
      { line: 0, quantity: 2, unit_price_cents: 300, unit_cost_cents: 90, catalog_version: 1, stamps_each: 1 },
      { line: 1, quantity: 1, unit_price_cents: 450, unit_cost_cents: 150, catalog_version: 1, stamps_each: 0 },
    ]);
    const { rows: audits } = await context.admin.query<{ actor_id: string; changes: Record<string, unknown> }>(
      "SELECT actor_id, changes FROM app.audit_log WHERE cafe_id = $1 AND action = 'card.stamped'",
      [app.owner.cafeId],
    );
    expect(audits).toEqual([{ actor_id: app.device.deviceId, changes: expect.objectContaining({ staffId: app.staffId, stamps: 2 }) as unknown }]);
  });

  it("adds no stamps within 30 minutes of a card's last stamps, in either order, but keeps the visit (AC 30)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const start = new Date(Date.now() - 2 * 60 * MINUTE);
    const token = { kind: "qr" as const, token: card.qr };
    expect(
      await sync(app, [
        await visit(app, token, { at: start }),
        await visit(app, token, { at: new Date(start.getTime() + 10 * MINUTE) }),
        // Recorded offline earlier and synced late: still inside the first visit's window.
        await visit(app, token, { at: new Date(start.getTime() - 20 * MINUTE) }),
        await visit(app, token, { at: new Date(start.getTime() + 31 * MINUTE) }),
      ]),
    ).toEqual([
      { status: "applied", code: "OK" },
      { status: "applied", code: "STAMP_COOLDOWN" },
      { status: "applied", code: "STAMP_COOLDOWN" },
      { status: "applied", code: "OK" },
    ]);
    expect(await stampsOf(card.cardId)).toBe(4);
    expect((await visitsOf(card.cardId)).map((row) => row.outcome)).toEqual(["cooldown", "stamped", "cooldown", "stamped"]);
  });

  it("enforces the cooldown in the database itself (AC 30)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    await sync(app, [await visit(app, { kind: "qr", token: card.qr })]);
    const { rows } = await context.admin.query<{ sync_event_id: string; device_id: string; staff_id: string }>(
      "SELECT sync_event_id, device_id, staff_id FROM app.visits WHERE card_id = $1",
      [card.cardId],
    );
    const first = rows[0];
    const error = await withCafe(context.testDb.app.db, app.owner.cafeId, async (trx) => {
      const ledger = await trx.selectFrom("sync_events").select(["key_id"]).where("id", "=", first?.sync_event_id ?? "").executeTakeFirstOrThrow();
      const event = await trx
        .insertInto("sync_events")
        .values({
          cafe_id: app.owner.cafeId,
          device_id: first?.device_id ?? "",
          event_id: randomUUID(),
          payload_hash: randomBytes(32),
          key_id: ledger.key_id,
          staff_id: first?.staff_id ?? "",
          type: "visit.recorded",
          schema_version: 1,
          sequence: 999,
          occurred_at: new Date(),
          status: "applied",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("visits")
        .values({
          cafe_id: app.owner.cafeId,
          sync_event_id: event.id,
          card_id: card.cardId,
          identified_by: "qr",
          device_id: first?.device_id ?? "",
          staff_id: first?.staff_id ?? "",
          occurred_at: new Date(Date.now() + 5 * MINUTE),
          total_cents: 300,
          stamps_earned: 1,
          stamps_added: 1,
          outcome: "stamped",
        })
        .execute();
    }).then(
      () => undefined,
      (caught: unknown) => (caught as { code?: string }).code,
    );
    expect(error).toBe("23P01");
  });

  it("stops adding stamps at the device's daily cap, counted per day in the café's time zone (AC 30)", async () => {
    const app = await cafeApp();
    const ten = await app.addType("Box of ten", 10);
    const box = (quantity: number) => [{ orderTypeId: ten, quantity, unitPriceCents: 300, unitCostCents: 90, catalogVersion: 1 }];
    const cards = await Promise.all(Array.from({ length: 3 }, () => issueCard(app.owner.cafeId)));
    const at = new Date();
    const yesterday = new Date(at.getTime() - 24 * 60 * MINUTE);
    expect(
      await sync(app, [
        await visit(app, { kind: "qr", token: cards[0]?.qr ?? "" }, { at, items: box(DAILY_STAMP_CAP / 10) }),
        await visit(app, { kind: "qr", token: cards[1]?.qr ?? "" }, { at, items: box(1) }),
        await visit(app, { kind: "qr", token: cards[2]?.qr ?? "" }, { at: yesterday, items: box(1) }),
      ]),
    ).toEqual([
      { status: "applied", code: "OK" },
      { status: "applied", code: "DAILY_STAMP_CAP" },
      { status: "applied", code: "OK" },
    ]);
    expect(await stampsOf(cards[1]?.cardId ?? "")).toBe(0);
  });

  it("stamps by phone number only a card already scanned at the counter, and answers a resend the same (AC 24)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId, { phone: "+96170111222" });
    const byPhone = await visit(app, { kind: "phone", phone: "+96170111222" });
    expect(await sync(app, [byPhone])).toEqual([{ status: "rejected", code: "PHONE_NOT_CONFIRMED" }]);
    expect(await sync(app, [byPhone])).toEqual([{ status: "rejected", code: "PHONE_NOT_CONFIRMED" }]);
    await sync(app, [await visit(app, { kind: "qr", token: card.qr }, { at: new Date(Date.now() - 60 * MINUTE) })]);
    expect(await sync(app, [await visit(app, { kind: "phone", phone: "+96170111222" })])).toEqual([{ status: "applied", code: "OK" }]);
    expect(await stampsOf(card.cardId)).toBe(4);
  });

  it("refuses unknown or forged cards, another café's cards, replaced QR codes and unknown order types", async () => {
    const app = await cafeApp();
    const other = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const elsewhere = await issueCard(other.owner.cafeId, { phone: "+96170333444", phoneConfirmed: true });
    const forged = signCardQr({ ...TEST_SECRETS, cardQr: { keys: [{ id: "q1", key: randomBytes(32) }] } }, { cardId: card.cardId, cafeId: app.owner.cafeId, epoch: 1 });
    const unknown = signCardQr(TEST_SECRETS, { cardId: randomUUID(), cafeId: app.owner.cafeId, epoch: 1 });
    await context.admin.query("UPDATE app.cards SET epoch = 2 WHERE id = $1", [card.cardId]);
    expect(
      await sync(app, [
        await visit(app, { kind: "qr", token: forged }),
        await visit(app, { kind: "qr", token: unknown }),
        await visit(app, { kind: "qr", token: elsewhere.qr }),
        await visit(app, { kind: "phone", phone: "+96170333444" }),
        await visit(app, { kind: "qr", token: card.qr }),
        await visit(app, { kind: "qr", token: signCardQr(TEST_SECRETS, { cardId: card.cardId, cafeId: app.owner.cafeId, epoch: 2 }) }, {
          items: [{ orderTypeId: other.coffee, quantity: 1, unitPriceCents: 300, unitCostCents: 90, catalogVersion: 1 }],
        }),
      ]),
    ).toEqual([
      { status: "rejected", code: "CARD_NOT_FOUND" },
      { status: "rejected", code: "CARD_NOT_FOUND" },
      { status: "rejected", code: "CARD_NOT_FOUND" },
      { status: "rejected", code: "CARD_NOT_FOUND" },
      { status: "rejected", code: "CARD_REPLACED" },
      { status: "rejected", code: "UNKNOWN_ORDER_TYPE" },
    ]);
  });

  it("applies a held visit only when the owner accepts it, and never a discarded one (AC 21)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    await app.as("POST", `/api/staff/${app.staffId}/revoke`);
    const first = await visit(app, { kind: "qr", token: card.qr }, { at: new Date(Date.now() - 2 * 60 * MINUTE) });
    const second = await visit(app, { kind: "qr", token: card.qr });
    expect(await sync(app, [first, second])).toEqual([
      { status: "applied", code: "HELD_FOR_REVIEW" },
      { status: "applied", code: "HELD_FOR_REVIEW" },
    ]);
    expect(await stampsOf(card.cardId)).toBe(0);
    const queue = (await app.as("GET", "/api/review-queue")).json<{ items: { id: string }[] }>().items;
    expect((await app.as("POST", `/api/review-queue/${queue[0]?.id ?? ""}/accept`)).statusCode).toBe(204);
    expect((await app.as("POST", `/api/review-queue/${queue[1]?.id ?? ""}/discard`)).statusCode).toBe(204);
    expect(await stampsOf(card.cardId)).toBe(2);
    expect((await visitsOf(card.cardId)).map((row) => row.outcome)).toEqual(["stamped", "discarded"]);
    expect(await auditActions(app.owner.cafeId)).toContain("card.stamped");
  });

  it("keeps visits but no link to a deleted card, and accepting one later adds nothing (AC 9)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    await sync(app, [await visit(app, { kind: "qr", token: card.qr }, { at: new Date(Date.now() - 2 * 60 * MINUTE) })]);
    await app.as("POST", `/api/staff/${app.staffId}/revoke`);
    await sync(app, [await visit(app, { kind: "qr", token: card.qr })]);
    await context.admin.query("DELETE FROM app.cards WHERE id = $1", [card.cardId]);
    const { rows } = await context.admin.query<{ card_id: string | null }>("SELECT card_id FROM app.visits WHERE cafe_id = $1", [app.owner.cafeId]);
    expect(rows).toEqual([{ card_id: null }, { card_id: null }]);
    const held = (await app.as("GET", "/api/review-queue")).json<{ items: { id: string }[] }>().items[0]?.id ?? "";
    expect((await app.as("POST", `/api/review-queue/${held}/accept`)).statusCode).toBe(204);
    const { rows: outcomes } = await context.admin.query<{ outcome: string }>("SELECT outcome FROM app.visits WHERE cafe_id = $1 ORDER BY occurred_at", [
      app.owner.cafeId,
    ]);
    expect(outcomes.map((row) => row.outcome)).toEqual(["stamped", "card_gone"]);
  });
});

describe("redemption", () => {
  async function redeem(app: App, cardQr: string, eventId: string = randomUUID(), staffId = app.staffId) {
    return app.app.inject({ method: "POST", url: "/api/device/redemptions", headers: withBearer(app.device.accessToken), payload: { eventId, staffId, cardQr } });
  }

  async function cardWithStamps(app: App, stamps: number) {
    const card = await issueCard(app.owner.cafeId);
    await context.admin.query("UPDATE app.cards SET stamps = $2 WHERE id = $1", [card.cardId, stamps]);
    return card;
  }

  it("takes the program's stamps once per redemption, and answers a retry the same (AC 31)", async () => {
    const app = await cafeApp();
    const card = await cardWithStamps(app, 4);
    const eventId = randomUUID();
    const first = await redeem(app, card.qr, eventId);
    expect(first.statusCode).toBe(201);
    expect(redemptionSchema.parse(first.json())).toEqual({ stampsUsed: 3, stampsLeft: 1, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" });
    const retry = await redeem(app, card.qr, eventId);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(await stampsOf(card.cardId)).toBe(1);
    const again = await redeem(app, card.qr);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("1 of the 3 stamps") as unknown });
    expect(await auditActions(app.owner.cafeId)).toContain("card.redeemed");
  });

  it("redeems once when the same redemption arrives twice at the same moment", async () => {
    const app = await cafeApp();
    const card = await cardWithStamps(app, 9);
    const eventId = randomUUID();
    const replies = await Promise.all([redeem(app, card.qr, eventId), redeem(app, card.qr, eventId)]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 201]);
    expect(await stampsOf(card.cardId)).toBe(6);
  });

  it("refuses another card under the same event id, a removed barista and a card that is not this café's", async () => {
    const app = await cafeApp();
    const card = await cardWithStamps(app, 3);
    const other = await cardWithStamps(app, 3);
    const eventId = randomUUID();
    await redeem(app, card.qr, eventId);
    expect((await redeem(app, other.qr, eventId)).json()).toMatchObject({ code: "CONFLICT" });
    const forged = signCardQr(TEST_SECRETS, { cardId: randomUUID(), cafeId: app.owner.cafeId, epoch: 1 });
    expect((await redeem(app, forged)).json()).toMatchObject({ code: "NOT_FOUND" });
    await app.as("POST", `/api/staff/${app.staffId}/revoke`);
    expect((await redeem(app, other.qr)).statusCode).toBe(403);
    expect(await stampsOf(other.cardId)).toBe(3);
  });
});

describe("device catalog", () => {
  it("lists the order types on sale with the catalog version and the reward, for current builds only", async () => {
    const app = await cafeApp();
    await app.addType("Old blend", 1, false);
    const response = await app.app.inject({ method: "GET", url: "/api/device/catalog", headers: withBearer(app.device.accessToken) });
    const catalog = deviceCatalogSchema.parse(response.json());
    expect(catalog.orderTypes.map((type) => type.nameEn)).toEqual(["Coffee", "Cake"]);
    expect(catalog.program).toEqual({ stampsRequired: 3, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" });
    const { rows } = await context.admin.query<{ catalog_version: number }>("SELECT catalog_version FROM app.cafes WHERE id = $1", [app.owner.cafeId]);
    expect(catalog.catalogVersion).toBe(rows[0]?.catalog_version);
    const old = await app.app.inject({
      method: "GET",
      url: "/api/device/catalog",
      headers: { authorization: `Bearer ${app.device.accessToken}`, [COUNTER_BUILT_AT_HEADER]: "2020-01-01T00:00:00Z" },
    });
    expect(old.statusCode).toBe(426);
  });
});
