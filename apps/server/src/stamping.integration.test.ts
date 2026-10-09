import { randomBytes, randomUUID } from "node:crypto";
import { withCafe } from "@cafe-loyalty/db";
import { COUNTER_BUILT_AT_HEADER, deviceCatalogSchema, redemptionSchema, syncResponseSchema } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { signCardQr } from "./customer-crypto.js";
import { DAILY_STAMP_CAP, STAMP_COOLDOWN_MINUTES } from "./stamping.js";
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
    // Against the visit, never the card, so deleting the card leaves no link in the log either (AC 9).
    const { rows: audits } = await context.admin.query<{ actor_id: string; entity_type: string; entity_id: string; changes: Record<string, unknown> }>(
      "SELECT actor_id, entity_type, entity_id, changes FROM app.audit_log WHERE cafe_id = $1 AND action = 'visit.stamped'",
      [app.owner.cafeId],
    );
    const { rows: visits } = await context.admin.query<{ id: string }>("SELECT id FROM app.visits WHERE card_id = $1", [card.cardId]);
    expect(audits).toEqual([{ actor_id: app.device.deviceId, entity_type: "visit", entity_id: visits[0]?.id, changes: { staffId: app.staffId, stamps: 2 } }]);
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
        await visit(app, token, { at: new Date(start.getTime() + (STAMP_COOLDOWN_MINUTES + 1) * MINUTE) }),
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

  it("stops adding stamps at each device's daily cap, counted per day in the café's time zone (AC 30)", async () => {
    const app = await cafeApp();
    const other = await pairDevice(app.app, app.owner, "Counter 2");
    const ten = await app.addType("Box of ten", 10);
    const box = (quantity: number) => [{ orderTypeId: ten, quantity, unitPriceCents: 300, unitCostCents: 90, catalogVersion: 1 }];
    const cards = await Promise.all(Array.from({ length: 4 }, () => issueCard(app.owner.cafeId)));
    const qr = (index: number) => ({ kind: "qr" as const, token: cards[index]?.qr ?? "" });
    // The café's last midnight, from PostgreSQL's own time zone rules: a few minutes either side are two café days but
    // one UTC day (Beirut is two or three hours ahead), on any date, daylight-saving changeovers included.
    const { rows } = await context.admin.query<{ midnight: Date; time_zone: string }>(
      "SELECT date_trunc('day', (now() - interval '5 minutes') AT TIME ZONE time_zone) AT TIME ZONE time_zone AS midnight, time_zone FROM app.cafes WHERE id = $1",
      [app.owner.cafeId],
    );
    expect(rows[0]?.time_zone).toBe("Asia/Beirut");
    const midnight = rows[0]?.midnight.getTime() ?? 0;
    const at = (minutes: number) => new Date(midnight + minutes * MINUTE);
    expect(
      await sync(app, [
        await visit(app, qr(0), { at: at(-1), items: box(DAILY_STAMP_CAP / 10) }),
        await visit(app, qr(1), { at: at(-2), items: box(1) }),
        // The next café day, though the same UTC day.
        await visit(app, qr(2), { at: at(1), items: box(1) }),
      ]),
    ).toEqual([
      { status: "applied", code: "OK" },
      { status: "applied", code: "DAILY_STAMP_CAP" },
      { status: "applied", code: "OK" },
    ]);
    // Another device's cap is its own.
    expect(await sync(app, [await visit(app, qr(3), { at: at(-3), items: box(1), device: other })], other.accessToken)).toEqual([
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
    // The stored refusal, though the number now works: a resend never turns into stamps.
    expect(await sync(app, [byPhone])).toEqual([{ status: "rejected", code: "PHONE_NOT_CONFIRMED" }]);
    expect(await sync(app, [await visit(app, { kind: "phone", phone: "+96170111222" })])).toEqual([{ status: "applied", code: "OK" }]);
    expect(await stampsOf(card.cardId)).toBe(4);
  });

  it("confirms a card's number on a scan that added no stamps", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId, { phone: "+96170111333" });
    const cakeOnly = [{ orderTypeId: app.cake, quantity: 1, unitPriceCents: 450, unitCostCents: 150, catalogVersion: 1 }];
    await sync(app, [await visit(app, { kind: "qr", token: card.qr }, { at: new Date(Date.now() - 60 * MINUTE), items: cakeOnly })]);
    expect(await visitsOf(card.cardId)).toMatchObject([{ outcome: "no_stamps" }]);
    expect(await sync(app, [await visit(app, { kind: "phone", phone: "+96170111333" })])).toEqual([{ status: "applied", code: "OK" }]);
    expect(await stampsOf(card.cardId)).toBe(2);
  });

  it("stops stamping a number by phone once a second card here signs up with it, scanned or not", async () => {
    const app = await cafeApp();
    const join = (await app.as("GET", "/api/cafe/join")).json<{ joinUrl: string }>().joinUrl;
    const code = /\/join\/([0-9a-f]{32})$/.exec(join)?.[1] ?? "missing";
    const signUpWith = (phone: string) =>
      app.app.inject({
        method: "POST",
        url: `/join/${code}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ phone, privacy: "yes", lang: "en" }).toString(),
      });
    expect((await signUpWith("70 404 505")).statusCode).toBe(303);
    const { rows } = await context.admin.query<{ id: string }>("SELECT id FROM app.cards WHERE cafe_id = $1", [app.owner.cafeId]);
    const qr = { kind: "qr" as const, token: signCardQr(TEST_SECRETS, { cardId: rows[0]?.id ?? "", cafeId: app.owner.cafeId, epoch: 1 }) };
    await sync(app, [await visit(app, qr, { at: new Date(Date.now() - 60 * MINUTE) })]);
    expect(await sync(app, [await visit(app, { kind: "phone", phone: "+96170404505" })])).toEqual([{ status: "applied", code: "OK" }]);
    // Someone else signs up here with the same number: the first card keeps its QR, but not the number.
    expect((await signUpWith("70 404 505")).statusCode).toBe(303);
    await sync(app, [await visit(app, qr, { at: new Date(Date.now() - 120 * MINUTE) })]);
    expect(await sync(app, [await visit(app, { kind: "phone", phone: "+96170404505" })])).toEqual([{ status: "rejected", code: "PHONE_DISPUTED" }]);
    expect(await stampsOf(rows[0]?.id ?? "")).toBe(6);
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
    expect((await app.as("POST", `/api/review-queue/${queue[0]?.id ?? ""}/accept`)).json()).toEqual({ outcome: "OK" });
    expect((await app.as("POST", `/api/review-queue/${queue[1]?.id ?? ""}/discard`)).json()).toEqual({ outcome: null });
    expect(await stampsOf(card.cardId)).toBe(2);
    expect((await visitsOf(card.cardId)).map((row) => row.outcome)).toEqual(["stamped", "discarded"]);
    expect(await auditActions(app.owner.cafeId)).toContain("visit.stamped");
  });

  it("holds a visit that arrives more than two days after it happened for the owner", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    expect(await sync(app, [await visit(app, { kind: "qr", token: card.qr }, { at: new Date(Date.now() - 3 * 24 * 60 * MINUTE) })])).toEqual([
      { status: "applied", code: "HELD_FOR_REVIEW" },
    ]);
    const queue = (await app.as("GET", "/api/review-queue")).json<{ items: { id: string; reason: string }[] }>().items;
    expect(queue).toMatchObject([{ reason: "late_sync" }]);
    await app.as("POST", `/api/review-queue/${queue[0]?.id ?? ""}/accept`);
    expect(await stampsOf(card.cardId)).toBe(2);
  });

  it("keeps visits and redemptions but no link to a card its holder deletes, and accepting one later adds nothing (AC 9)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    await sync(app, [await visit(app, { kind: "qr", token: card.qr }, { at: new Date(Date.now() - 2 * 60 * MINUTE) })]);
    await context.admin.query("UPDATE app.cards SET stamps = 3 WHERE id = $1", [card.cardId]);
    const redeemed = await app.app.inject({
      method: "POST",
      url: "/api/device/redemptions",
      headers: withBearer(app.device.accessToken),
      payload: { eventId: randomUUID(), staffId: app.staffId, cardQr: card.qr },
    });
    expect(redeemed.statusCode).toBe(201);
    await app.as("POST", `/api/staff/${app.staffId}/revoke`);
    await sync(app, [await visit(app, { kind: "qr", token: card.qr })]);
    // The card holder deletes the card from its own page, as the app role.
    const deleted = await app.app.inject({
      method: "POST",
      url: `/c/${card.webSecret}/delete`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "confirm=yes",
    });
    expect(deleted.statusCode).toBe(200);
    const { rows } = await context.admin.query<{ card_id: string | null }>("SELECT card_id FROM app.visits WHERE cafe_id = $1", [app.owner.cafeId]);
    expect(rows).toEqual([{ card_id: null }, { card_id: null }]);
    const { rows: redemptions } = await context.admin.query<{ card_id: string | null }>("SELECT card_id FROM app.redemptions WHERE cafe_id = $1", [
      app.owner.cafeId,
    ]);
    expect(redemptions).toEqual([{ card_id: null }]);
    // Nor does the log name the card anywhere but its own create and delete rows.
    const { rows: logged } = await context.admin.query<{ action: string }>("SELECT action FROM app.audit_log WHERE entity_id = $1 ORDER BY id", [card.cardId]);
    expect(logged.map((row) => row.action)).toEqual(["card.deleted"]);
    const held = (await app.as("GET", "/api/review-queue")).json<{ items: { id: string }[] }>().items[0]?.id ?? "";
    // The owner is told the accepted visit added nothing.
    expect((await app.as("POST", `/api/review-queue/${held}/accept`)).json()).toEqual({ outcome: "CARD_GONE" });
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
    expect(await auditActions(app.owner.cafeId)).toContain("reward.redeemed");
  });

  it("answers a retry from a build that aged out since, and refuses that build a new redemption (AC 26)", async () => {
    const app = await cafeApp();
    const card = await cardWithStamps(app, 6);
    const eventId = randomUUID();
    expect((await redeem(app, card.qr, eventId)).statusCode).toBe(201);
    const fromOldBuild = (id: string) =>
      app.app.inject({
        method: "POST",
        url: "/api/device/redemptions",
        headers: { authorization: `Bearer ${app.device.accessToken}`, [COUNTER_BUILT_AT_HEADER]: "2020-01-01T00:00:00Z" },
        payload: { eventId: id, staffId: app.staffId, cardQr: card.qr },
      });
    expect((await fromOldBuild(eventId)).statusCode).toBe(200);
    expect((await fromOldBuild(randomUUID())).statusCode).toBe(426);
    expect(await stampsOf(card.cardId)).toBe(3);
  });

  it("redeems once when the same redemption arrives twice at the same moment, and answers both the same", async () => {
    const app = await cafeApp();
    for (const stamps of [9, 4]) {
      const card = await cardWithStamps(app, stamps);
      const eventId = randomUUID();
      const replies = await Promise.all([redeem(app, card.qr, eventId), redeem(app, card.qr, eventId)]);
      expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 201]);
      const [first, second] = replies;
      expect(first.json()).toEqual(second.json());
      expect(await stampsOf(card.cardId)).toBe(stamps - 3);
    }
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
