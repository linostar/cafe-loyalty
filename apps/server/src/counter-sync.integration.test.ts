import { randomUUID } from "node:crypto";
import { COUNTER_BUILT_AT_HEADER, MAX_SYNC_BATCH, pairResponseSchema, reviewQueueSchema, syncResponseSchema } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { hashToken } from "./credentials.js";
import { REVIEW_PAGE_SIZE, SYNC_BODY_LIMIT_BYTES } from "./sync-routes.js";
import {
  CURRENT_BUILD,
  RELEASE_BUILT_AT,
  deviceKeyPair,
  pairProof,
  signedEvent,
  signedRenewal,
  useApiHarness,
  withBearer,
  withCookie,
  type PairedDevice,
} from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, pairDevice, auditActions, issueCard } = context;

/**
 * Each café's order type and card, by device: these tests are about the sync protocol, so the order type earns no
 * stamps and the stamping rules (stamping.integration.test.ts) never change an answer.
 */
const cafeOf = new Map<string, { orderTypeId: string; qr: string }>();
let lastCafe: { orderTypeId: string; qr: string } = { orderTypeId: "missing", qr: "missing" };
const ORDER_TYPE = { nameAr: "إسبريسو", nameEn: "Espresso", priceCents: 350, costCents: 120, stampsEarned: 0 };

async function counterApp() {
  const h = await harness();
  const owner = await signUp(h.app);
  const as = (method: "GET" | "POST", url: string, payload: Record<string, unknown> = {}) =>
    h.app.inject({ method, url, headers: withCookie(owner.session), ...(method === "GET" ? {} : { payload }) });
  const staff = (await as("POST", "/api/staff", { name: "Rami", pin: "482913" })).json<{ staff: { id: string }[] }>().staff;
  const staffId = staff[0]?.id ?? "missing";
  const device = await pairDevice(h.app, owner);
  const orderTypeId = (await as("POST", "/api/cafe/order-types", ORDER_TYPE)).json<{ orderTypes: { id: string }[] }>().orderTypes[0]?.id ?? "missing";
  const { qr } = await issueCard(owner.cafeId);
  lastCafe = { orderTypeId, qr };
  cafeOf.set(device.deviceId, lastCafe);
  return { ...h, owner, as, staffId, device, orderTypeId, qr };
}

let sequence = 0;

/** A valid visit as the counter records it, signed by `device`. */
function visit(device: PairedDevice, staffId: string, overrides: Record<string, unknown> = {}) {
  sequence += 1;
  const { orderTypeId, qr } = cafeOf.get(device.deviceId) ?? lastCafe;
  return signedEvent(device, {
    eventId: randomUUID(),
    staffId,
    sequence,
    schemaVersion: 1,
    type: "visit.recorded",
    occurredAt: new Date().toISOString(),
    payload: {
      card: { kind: "qr", token: qr },
      items: [{ orderTypeId, quantity: 2, unitPriceCents: 350, unitCostCents: 120, catalogVersion: 1 }],
      totalCents: 700,
    },
    ...overrides,
  });
}

async function sync(app: Awaited<ReturnType<typeof harness>>["app"], token: string, events: unknown[]) {
  const response = await app.inject({ method: "POST", url: "/api/device/sync", headers: withBearer(token), payload: { events } });
  expect(response.statusCode).toBe(200);
  return syncResponseSchema.parse(response.json()).results.map(({ status, code }) => ({ status, code }));
}

async function ledger(deviceId: string) {
  const { rows } = await context.admin.query<{ device_id: string; status: string; hold_reason: string | null; type: string; sequence: number }>(
    "SELECT device_id, status, hold_reason, type, sequence FROM app.sync_events WHERE device_id = $1 ORDER BY received_at, id",
    [deviceId],
  );
  return rows;
}

describe("sync", () => {
  it("records an event once: the same event again is a duplicate, other content under its id a conflict (AC 24)", async () => {
    const { app, device, staffId } = await counterApp();
    const event = await visit(device, staffId);
    expect(await sync(app, device.accessToken, [event])).toEqual([{ status: "applied", code: "OK" }]);
    expect(await sync(app, device.accessToken, [event])).toEqual([{ status: "duplicate", code: "DUPLICATE" }]);
    const altered = await visit(device, staffId, { eventId: event.eventId, sequence: 999 });
    expect(await sync(app, device.accessToken, [altered])).toEqual([{ status: "rejected", code: "IDEMPOTENCY_CONFLICT" }]);
    expect(await ledger(device.deviceId)).toEqual([{ device_id: device.deviceId, status: "applied", hold_reason: null, type: "visit.recorded", sequence: event.sequence }]);
  });

  it("judges each event on its own and answers every one by index (AC 23, 25, 26)", async () => {
    const { app, device, staffId } = await counterApp();
    const other = await deviceKeyPair();
    const now = Date.now();
    const events = [
      await visit(device, staffId),
      await visit(device, staffId, { payload: { card: { kind: "qr", token: lastCafe.qr }, items: [], totalCents: 0 } }),
      await visit(device, staffId, { type: "test.never-supported" }),
      await visit(device, staffId, { schemaVersion: 4 }),
      await visit({ ...device, privateKey: other.privateKey }, staffId),
      await visit({ ...device, deviceId: randomUUID() }, staffId),
      await visit(device, staffId, { occurredAt: new Date(now + 10 * 60 * 1000).toISOString() }),
      await visit(device, staffId, { occurredAt: new Date(now + 25 * 60 * 60 * 1000).toISOString() }),
      await visit(device, staffId, { occurredAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() }),
      await visit(device, randomUUID()),
      { eventId: "not-an-id" },
      // A newer build's extra field is signed with the rest, then stripped.
      await visit(device, staffId, { fromNewerBuild: { note: "kept in the signature" } }),
    ];
    expect(await sync(app, device.accessToken, events)).toEqual([
      { status: "applied", code: "OK" },
      { status: "rejected", code: "INVALID_EVENT" },
      { status: "retry_later", code: "UNSUPPORTED_EVENT" },
      { status: "retry_later", code: "UNSUPPORTED_EVENT" },
      { status: "rejected", code: "SIGNATURE_INVALID" },
      { status: "rejected", code: "INVALID_EVENT" },
      // A phone clock a little fast: kept for later. A day or more off, or a month old: refused.
      { status: "retry_later", code: "CLOCK_AHEAD" },
      { status: "rejected", code: "CLOCK_SKEW" },
      { status: "rejected", code: "CLOCK_SKEW" },
      { status: "rejected", code: "INVALID_EVENT" },
      { status: "rejected", code: "INVALID_EVENT" },
      { status: "applied", code: "OK" },
    ]);
    expect(await ledger(device.deviceId)).toHaveLength(2);
  });

  it("takes the device from the token and records when the event arrived (AC 25)", async () => {
    const { app, device, staffId } = await counterApp();
    const event = await visit(device, staffId, { occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() });
    await sync(app, device.accessToken, [event]);
    const { rows } = await context.admin.query<{ late: boolean }>(
      "SELECT received_at - occurred_at > interval '2 days' AS late FROM app.sync_events WHERE event_id = $1",
      [event.eventId],
    );
    expect(rows).toEqual([{ late: true }]);
  });

  it("accepts a full batch of the largest events within the body limit, and stores the largest visit", async () => {
    const { app, owner, device, staffId, orderTypeId, qr } = await counterApp();
    const items = Array.from({ length: 30 }, () => ({ orderTypeId, quantity: 50, unitPriceCents: 66_666, unitCostCents: 99_999_999, catalogVersion: 2_147_483_647 }));
    // The longest card reference v1 accepts, which no card has: refused, but carried in full. The last one is a real
    // card, so the largest items and numbers v1 accepts are stored too.
    const events = await Promise.all(
      Array.from({ length: MAX_SYNC_BATCH }, (_, index) =>
        visit(device, staffId, {
          payload: { card: { kind: "qr", token: index === MAX_SYNC_BATCH - 1 ? qr : "Q".repeat(512) }, items, totalCents: 30 * 50 * 66_666 },
        }),
      ),
    );
    const body = JSON.stringify({ events });
    expect(body.length).toBeLessThan(SYNC_BODY_LIMIT_BYTES);
    const results = await sync(app, device.accessToken, events);
    expect(results.map((result) => result.code)).toEqual([...Array.from({ length: MAX_SYNC_BATCH - 1 }, () => "CARD_NOT_FOUND"), "OK"]);
    const { rows } = await context.admin.query("SELECT count(*)::int AS lines, max(catalog_version) AS version FROM app.visit_items WHERE cafe_id = $1", [
      owner.cafeId,
    ]);
    expect(rows).toEqual([{ lines: 30, version: 2_147_483_647 }]);
  });

  it("refuses a body over the limit with the shared envelope", async () => {
    const { app, device } = await counterApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/device/sync",
      headers: { ...withBearer(device.accessToken), "content-type": "application/json" },
      payload: JSON.stringify({ events: [{ padding: "x".repeat(SYNC_BODY_LIMIT_BYTES) }] }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });
  });

  it("refuses an event signed with another device's key, even of the same café", async () => {
    const { app, owner, device, staffId } = await counterApp();
    const other = await pairDevice(app, owner, "Counter 2");
    const borrowed = await visit({ ...device, keyId: other.keyId, privateKey: other.privateKey }, staffId);
    expect(await sync(app, device.accessToken, [borrowed])).toEqual([{ status: "rejected", code: "SIGNATURE_INVALID" }]);
  });

  it("audits a PIN lockout report at once, even from a removed barista (AC 19)", async () => {
    const { app, as, owner, device, staffId } = await counterApp();
    await as("POST", `/api/staff/${staffId}/revoke`);
    const lockout = await signedEvent(device, {
      eventId: randomUUID(),
      staffId,
      sequence: 1,
      schemaVersion: 1,
      type: "staff.pin_lockout",
      occurredAt: new Date().toISOString(),
      payload: { failedAttempts: 6, lockedUntil: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(await sync(app, device.accessToken, [lockout])).toEqual([{ status: "applied", code: "OK" }]);
    const { rows } = await context.admin.query<{ changes: Record<string, unknown> }>(
      "SELECT changes FROM app.audit_log WHERE cafe_id = $1 AND action = 'staff.pin_locked_out'",
      [owner.cafeId],
    );
    expect(rows).toEqual([{ changes: expect.objectContaining({ failedAttempts: 6, reportedAfter: "staff_revoked" }) as unknown }]);
    expect(reviewQueueSchema.parse((await as("GET", "/api/review-queue")).json()).items).toEqual([]);
  });

  it("records a PIN lockout in the audit log (AC 19)", async () => {
    const { app, owner, device, staffId } = await counterApp();
    const lockout = await signedEvent(device, {
      eventId: randomUUID(),
      staffId,
      sequence: 1,
      schemaVersion: 1,
      type: "staff.pin_lockout",
      occurredAt: new Date().toISOString(),
      payload: { failedAttempts: 5, lockedUntil: new Date(Date.now() + 30_000).toISOString() },
    });
    expect(await sync(app, device.accessToken, [lockout])).toEqual([{ status: "applied", code: "OK" }]);
    expect(await auditActions(owner.cafeId)).toContain("staff.pin_locked_out");
  });

  it("never logs event contents", async () => {
    const { app, device, staffId, logs } = await counterApp();
    const event = await visit(device, staffId, { payload: { card: { kind: "phone", phone: "+96170123456" }, items: [{ orderTypeId: lastCafe.orderTypeId, quantity: 1, unitPriceCents: 350, unitCostCents: 120, catalogVersion: 1 }], totalCents: 350 } });
    await sync(app, device.accessToken, [event, { ...event, eventId: randomUUID() }]);
    const output = logs.join("");
    expect(output).toContain("sync handled");
    for (const secret of ["+96170123456", "70123456", String(event.signature), device.accessToken]) {
      expect(output).not.toContain(secret);
    }
  });

  it("only uses staff of the device's own café", async () => {
    const first = await counterApp();
    const second = await counterApp();
    expect(await sync(first.app, first.device.accessToken, [await visit(first.device, second.staffId)])).toEqual([{ status: "rejected", code: "INVALID_EVENT" }]);
  });
});

describe("review queue", () => {
  it("holds events from a removed barista instead of applying or dropping them (AC 21)", async () => {
    const { app, as, owner, device, staffId } = await counterApp();
    await as("POST", `/api/staff/${staffId}/revoke`);
    expect(await sync(app, device.accessToken, [await visit(device, staffId)])).toEqual([{ status: "applied", code: "HELD_FOR_REVIEW" }]);
    const queue = reviewQueueSchema.parse((await as("GET", "/api/review-queue")).json());
    expect(queue).toMatchObject({ items: [{ type: "visit.recorded", deviceName: "Counter 1", staffName: "Rami", reason: "staff_revoked" }], nextCursor: null });
    const id = queue.items[0]?.id ?? "missing";
    // A visit whose items earn no stamps: accepted, and it says so.
    expect((await as("POST", `/api/review-queue/${id}/accept`)).json()).toEqual({ outcome: "OK" });
    expect((await as("POST", `/api/review-queue/${id}/discard`)).json()).toMatchObject({ code: "NOT_FOUND" });
    expect(reviewQueueSchema.parse((await as("GET", "/api/review-queue")).json()).items).toEqual([]);
    expect(await ledger(device.deviceId)).toEqual([expect.objectContaining({ status: "applied", hold_reason: "staff_revoked" })]);
    expect(await auditActions(owner.cafeId)).toContain("sync_event.accepted");
  });

  it("takes a removed device's queue while its token lasts, then tells it so (AC 21)", async () => {
    const { app, as, device, staffId } = await counterApp();
    const event = await visit(device, staffId);
    await as("POST", `/api/devices/${device.deviceId}/revoke`);
    const handedOver = await app.inject({ method: "POST", url: "/api/device/sync", headers: withBearer(device.accessToken), payload: { events: [event] } });
    expect(handedOver.json()).toEqual({ results: [{ index: 0, eventId: event.eventId, status: "applied", code: "HELD_FOR_REVIEW" }], deviceRevoked: true });
    expect((await app.inject({ method: "GET", url: "/api/device/staff", headers: withBearer(device.accessToken) })).json()).toMatchObject({ code: "DEVICE_REVOKED" });
    await context.admin.query("UPDATE app.device_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(device.accessToken)]);
    const expired = await app.inject({ method: "POST", url: "/api/device/sync", headers: withBearer(device.accessToken), payload: { events: [event] } });
    expect(expired.json()).toMatchObject({ code: "DEVICE_REVOKED" });

    const queue = reviewQueueSchema.parse((await as("GET", "/api/review-queue")).json());
    expect(queue.items).toMatchObject([{ reason: "device_revoked" }]);
    expect((await as("POST", `/api/review-queue/${queue.items[0]?.id ?? "missing"}/discard`)).json()).toEqual({ outcome: null });
    expect(await ledger(device.deviceId)).toEqual([expect.objectContaining({ status: "discarded" })]);
  });

  it("pages oldest first with an opaque cursor and a server-enforced page size (AC 40)", async () => {
    const { app, as, device, staffId } = await counterApp();
    await as("POST", `/api/staff/${staffId}/revoke`);
    const events = await Promise.all(Array.from({ length: REVIEW_PAGE_SIZE + 3 }, () => visit(device, staffId)));
    await sync(app, device.accessToken, events.slice(0, REVIEW_PAGE_SIZE + 1));
    const first = reviewQueueSchema.parse((await as("GET", "/api/review-queue")).json());
    expect(first.items).toHaveLength(REVIEW_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    // Events that sync while the owner is paging join the end: no duplicates, no gaps.
    await sync(app, device.accessToken, events.slice(REVIEW_PAGE_SIZE + 1));
    const second = reviewQueueSchema.parse((await as("GET", `/api/review-queue?cursor=${first.nextCursor ?? ""}`)).json());
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(REVIEW_PAGE_SIZE + 3);
    expect((await as("GET", "/api/review-queue?cursor=bm90LWEtY3Vyc29y")).json()).toMatchObject({ code: "VALIDATION_FAILED" });
    const impossible = Buffer.from(JSON.stringify(["2026-02-30T25:61:00.000000Z", randomUUID()])).toString("base64url");
    const refused = await as("GET", `/api/review-queue?cursor=${impossible}`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("stays within its café", async () => {
    const first = await counterApp();
    const second = await counterApp();
    await first.as("POST", `/api/staff/${first.staffId}/revoke`);
    await sync(first.app, first.device.accessToken, [await visit(first.device, first.staffId)]);
    const id = reviewQueueSchema.parse((await first.as("GET", "/api/review-queue")).json()).items[0]?.id ?? "missing";
    expect(reviewQueueSchema.parse((await second.as("GET", "/api/review-queue")).json()).items).toEqual([]);
    expect((await second.as("POST", `/api/review-queue/${id}/accept`)).statusCode).toBe(404);
  });
});

describe("pairing again", () => {
  async function pairAgain(setup: Awaited<ReturnType<typeof counterApp>>, previous: PairedDevice | undefined, code?: string) {
    code ??= (await setup.as("POST", "/api/devices/pairing-codes", { deviceName: "Front counter" })).json<{ code: string }>().code;
    const { privateKey, publicJwk } = await deviceKeyPair();
    const response = await setup.app.inject({
      method: "POST",
      url: "/api/device/pair",
      headers: CURRENT_BUILD,
      payload: { code, publicKey: publicJwk, ...(previous === undefined ? {} : { previous: await pairProof(previous, code, publicJwk) }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = pairResponseSchema.parse(response.json());
    return { deviceId: body.deviceId, keyId: body.keyId, accessToken: body.accessToken, privateKey };
  }

  it("keeps the device id, so a queue from before syncs, and only the new key renews (AC 18)", async () => {
    const setup = await counterApp();
    const { app, owner, device, staffId } = setup;
    const queued = await visit(device, staffId);
    await context.admin.query("UPDATE app.devices SET last_renewed_at = now() - interval '8 days' WHERE id = $1", [device.deviceId]);
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(device) })).json()).toMatchObject({ code: "PAIRING_REQUIRED" });

    const again = await pairAgain(setup, device);
    expect(again.deviceId).toBe(device.deviceId);
    expect(again.keyId).not.toBe(device.keyId);
    expect(await sync(app, again.accessToken, [queued, await visit(again, staffId)])).toEqual([
      { status: "applied", code: "OK" },
      { status: "applied", code: "OK" },
    ]);
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(device) })).json()).toMatchObject({ code: "PAIRING_REQUIRED" });
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(again) })).statusCode).toBe(200);
    // The old token went with the old pairing.
    expect((await app.inject({ method: "GET", url: "/api/device/me", headers: withBearer(device.accessToken) })).json()).toMatchObject({ code: "TOKEN_EXPIRED" });
    const devices = (await setup.as("GET", "/api/devices")).json<{ devices: { id: string; name: string }[] }>().devices;
    expect(devices).toEqual([expect.objectContaining({ id: device.deviceId, name: "Front counter" })]);
    expect(await auditActions(owner.cafeId)).toContain("device.paired_again");
  });

  it("brings back a removed device, holding what its old key signed for review (AC 21)", async () => {
    const setup = await counterApp();
    const { app, as, device, staffId } = setup;
    const queued = await visit(device, staffId);
    await as("POST", `/api/devices/${device.deviceId}/revoke`);
    const again = await pairAgain(setup, device);
    expect(again.deviceId).toBe(device.deviceId);
    expect(await sync(app, again.accessToken, [queued, await visit(again, staffId)])).toEqual([
      { status: "applied", code: "HELD_FOR_REVIEW" },
      { status: "applied", code: "OK" },
    ]);
    expect((await as("GET", "/api/devices")).json()).toMatchObject({ devices: [{ id: device.deviceId, revoked: false }] });
  });

  it("pairs a new device when the proof does not check out", async () => {
    const setup = await counterApp();
    const forged = { ...setup.device, privateKey: (await deviceKeyPair()).privateKey };
    expect((await pairAgain(setup, forged)).deviceId).not.toBe(setup.device.deviceId);
  });

  it("refuses a proof made for another code, so a captured one cannot be reused", async () => {
    const setup = await counterApp();
    const first = (await setup.as("POST", "/api/devices/pairing-codes", { deviceName: "Front counter" })).json<{ code: string }>().code;
    const second = (await setup.as("POST", "/api/devices/pairing-codes", { deviceName: "Front counter" })).json<{ code: string }>().code;
    const { publicJwk } = await deviceKeyPair();
    const response = await setup.app.inject({
      method: "POST",
      url: "/api/device/pair",
      headers: CURRENT_BUILD,
      payload: { code: second, publicKey: publicJwk, previous: await pairProof(setup.device, first, publicJwk) },
    });
    expect(pairResponseSchema.parse(response.json()).deviceId).not.toBe(setup.device.deviceId);
  });

  it("will not move a phone holding another café's identity without it starting over, and keeps the code", async () => {
    const setup = await counterApp();
    const elsewhere = await counterApp();
    const code = (await setup.as("POST", "/api/devices/pairing-codes", { deviceName: "Front counter" })).json<{ code: string }>().code;
    const { publicJwk } = await deviceKeyPair();
    const refused = await setup.app.inject({
      method: "POST",
      url: "/api/device/pair",
      headers: CURRENT_BUILD,
      payload: { code, publicKey: publicJwk, previous: await pairProof(elsewhere.device, code, publicJwk) },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "PAIRED_ELSEWHERE" });
    // Starting over (no previous identity) pairs a new device with the same, still unused code.
    expect((await pairAgain(setup, undefined, code)).deviceId).not.toBe(elsewhere.device.deviceId);
  });
});

describe("counter builds", () => {
  it("serve new actions only to builds from the last 14 days, and let any build pair, renew and sync (AC 26)", async () => {
    const { app, as, device, staffId } = await counterApp();
    const old = { [COUNTER_BUILT_AT_HEADER]: new Date(RELEASE_BUILT_AT.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString() };
    const auth = { authorization: `Bearer ${device.accessToken}` };
    for (const headers of [{ ...auth, ...old }, auth, { ...auth, [COUNTER_BUILT_AT_HEADER]: "last week" }]) {
      const response = await app.inject({ method: "GET", url: "/api/device/staff", headers });
      expect(response.statusCode).toBe(426);
      expect(response.json()).toMatchObject({ code: "CLIENT_TOO_OLD", retryable: false });
    }
    const recent = { [COUNTER_BUILT_AT_HEADER]: new Date(RELEASE_BUILT_AT.getTime() - 13 * 24 * 60 * 60 * 1000).toISOString() };
    expect((await app.inject({ method: "GET", url: "/api/device/staff", headers: { ...auth, ...recent } })).statusCode).toBe(200);

    const synced = await app.inject({ method: "POST", url: "/api/device/sync", headers: { ...auth, ...old }, payload: { events: [await visit(device, staffId)] } });
    expect(synced.json()).toMatchObject({ results: [{ code: "OK" }] });
    const renewed = await app.inject({ method: "POST", url: "/api/device/token", headers: old, payload: await signedRenewal(device) });
    expect(renewed.statusCode).toBe(200);
    // An old build that must pair again can, to hand over its queue.
    const code = (await as("POST", "/api/devices/pairing-codes", { deviceName: "Old phone" })).json<{ code: string }>().code;
    const repaired = await app.inject({ method: "POST", url: "/api/device/pair", headers: old, payload: { code, publicKey: (await deviceKeyPair()).publicJwk } });
    expect(repaired.statusCode).toBe(201);
  });
});
