import { describe, expect, it } from "vitest";
import {
  MAX_SYNC_BATCH,
  MAX_SYNC_SEQUENCE,
  SYNC_EVENT_SIGNING_PREFIX,
  SYNC_RESULT_CODES,
  isFinalSyncStatus,
  parseSyncEvent,
  readSyncResponse,
  syncRequestSchema,
  syncResponseSchema,
  syncEventSigningPayload,
  syncResult,
} from "./sync.js";

const ids = {
  event: "0f8b6c1e-7d6a-4c3b-9a1e-2b3c4d5e6f70",
  device: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
  key: "4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a",
  staff: "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e",
  orderType: "3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f",
};

const SIGNATURE = "A".repeat(86);

function visitEvent(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: ids.event,
    deviceId: ids.device,
    keyId: ids.key,
    staffId: ids.staff,
    sequence: 7,
    schemaVersion: 1,
    type: "visit.recorded",
    occurredAt: "2026-10-08T07:30:00.000Z",
    signature: SIGNATURE,
    payload: {
      card: { kind: "phone", phone: "+96170123456" },
      items: [{ orderTypeId: ids.orderType, quantity: 2, unitPriceCents: 350, unitCostCents: 120, catalogVersion: 3 }],
      totalCents: 700,
      ...payload,
    },
    ...overrides,
  };
}

describe("parseSyncEvent", () => {
  it("accepts a valid visit and strips unknown fields at every level", () => {
    const result = parseSyncEvent(
      visitEvent({ fromNewerBuild: true }, { note: "extra", card: { kind: "qr", token: "abc.def", extra: 1 } }),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.event.type !== "visit.recorded") return;
    expect(result.event).not.toHaveProperty("fromNewerBuild");
    expect(result.event.payload).not.toHaveProperty("note");
    expect(result.event.payload.card).toEqual({ kind: "qr", token: "abc.def" });
    expect(result.event.keyId).toBe(ids.key);
  });

  it("lowercases ids so they match the database's uuid output", () => {
    const result = parseSyncEvent(visitEvent({ eventId: ids.event.toUpperCase(), deviceId: ids.device.toUpperCase() }));
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.event.eventId).toBe(ids.event);
    expect(result.event.deviceId).toBe(ids.device);
  });

  it("reports an unknown type or version as unsupported, not invalid", () => {
    expect(parseSyncEvent(visitEvent({ type: "visit.voided" }))).toEqual({
      status: "unsupported",
      eventId: ids.event,
      type: "visit.voided",
      schemaVersion: 1,
    });
    expect(parseSyncEvent(visitEvent({ schemaVersion: 2 }))).toMatchObject({ status: "unsupported", schemaVersion: 2 });
  });

  it("reports an unknown type as unsupported even when its other fields break the v1 rules", () => {
    const raw = { eventId: ids.event, type: "pin.lockout", schemaVersion: 1, deviceId: "not-a-uuid", attempts: 5 };
    expect(parseSyncEvent(raw)).toMatchObject({ status: "unsupported", type: "pin.lockout" });
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("treats the prototype key %s as an unknown type", (type) => {
    expect(parseSyncEvent(visitEvent({ type }))).toMatchObject({ status: "unsupported", type });
  });

  it("rejects a total that does not match its items", () => {
    expect(parseSyncEvent(visitEvent({}, { totalCents: 650 }))).toMatchObject({
      status: "invalid",
      eventId: ids.event,
      issues: [{ path: "payload.totalCents" }],
    });
  });

  it("rejects items that add up beyond the maximum", () => {
    const items = [{ orderTypeId: ids.orderType, quantity: 50, unitPriceCents: 100_000_000, unitCostCents: 0, catalogVersion: 1 }];
    expect(parseSyncEvent(visitEvent({}, { items, totalCents: 0 }))).toMatchObject({ status: "invalid", issues: [{ path: "payload.items" }] });
  });

  it.each([
    ["a local time", "2026-10-08T10:30:00"],
    ["an offset", "2026-10-08T10:30:00+03:00"],
    ["no seconds", "2026-10-08T07:30Z"],
    ["an impossible date", "2026-02-30T00:00:00Z"],
  ])("rejects occurredAt with %s", (_label, occurredAt) => {
    expect(parseSyncEvent(visitEvent({ occurredAt })).status).toBe("invalid");
  });

  it("rejects fractional cents, invalid phone numbers, unknown card kinds and malformed signatures", () => {
    const items = [{ orderTypeId: ids.orderType, quantity: 1, unitPriceCents: 3.5, unitCostCents: 1, catalogVersion: 1 }];
    expect(parseSyncEvent(visitEvent({}, { items, totalCents: 3.5 })).status).toBe("invalid");
    expect(parseSyncEvent(visitEvent({}, { card: { kind: "phone", phone: "70123456" } })).status).toBe("invalid");
    expect(parseSyncEvent(visitEvent({}, { card: { kind: "nfc", uid: "04A2" } })).status).toBe("invalid");
    expect(parseSyncEvent(visitEvent({ signature: "short" })).status).toBe("invalid");
    expect(parseSyncEvent(visitEvent({ keyId: undefined })).status).toBe("invalid");
  });

  it("caps the sequence at what the server stores", () => {
    expect(parseSyncEvent(visitEvent({ sequence: MAX_SYNC_SEQUENCE })).status).toBe("valid");
    expect(parseSyncEvent(visitEvent({ sequence: MAX_SYNC_SEQUENCE + 1 })).status).toBe("invalid");
  });

  it("caps an item's catalog version at what the server stores", () => {
    const item = (catalogVersion: number) => ({ items: [{ orderTypeId: ids.orderType, quantity: 2, unitPriceCents: 350, unitCostCents: 120, catalogVersion }] });
    expect(parseSyncEvent(visitEvent({}, item(2_147_483_647))).status).toBe("valid");
    expect(parseSyncEvent(visitEvent({}, item(2_147_483_648))).status).toBe("invalid");
  });

  it("accepts a PIN lockout report (AC 19)", () => {
    const lockout = visitEvent({ type: "staff.pin_lockout", payload: { failedAttempts: 5, lockedUntil: "2026-10-08T07:30:30.000Z" } });
    expect(parseSyncEvent(lockout)).toMatchObject({ status: "valid", event: { type: "staff.pin_lockout", payload: { failedAttempts: 5 } } });
    expect(parseSyncEvent({ ...lockout, payload: { failedAttempts: 0, lockedUntil: "soon" } }).status).toBe("invalid");
  });

  it("keeps the event id when it can, and returns null when the id itself is unreadable", () => {
    expect(parseSyncEvent(visitEvent({ sequence: -1 }))).toMatchObject({ status: "invalid", eventId: ids.event });
    expect(parseSyncEvent(visitEvent({ eventId: "not-a-uuid" }))).toMatchObject({ status: "invalid", eventId: null });
    expect(parseSyncEvent("not an object")).toMatchObject({ status: "invalid", eventId: null });
  });
});

describe("syncEventSigningPayload", () => {
  it("prefixes, sorts keys at every level and leaves out the signature", () => {
    const a = syncEventSigningPayload({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" }, signature: "s1" });
    const b = syncEventSigningPayload({ signature: "s2", a: { c: "x", d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(`${SYNC_EVENT_SIGNING_PREFIX}{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}`);
  });

  it("covers fields the server does not know, so newer builds verify and hash consistently", () => {
    expect(syncEventSigningPayload(visitEvent({ fromNewerBuild: true }))).not.toBe(syncEventSigningPayload(visitEvent()));
  });

  it("keeps an own __proto__ key from parsed JSON as data", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    expect(syncEventSigningPayload(parsed)).toBe(`${SYNC_EVENT_SIGNING_PREFIX}{"__proto__":{"polluted":true},"a":1}`);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("accepts only plain objects", () => {
    expect(() => syncEventSigningPayload([1, 2])).toThrow(TypeError);
    expect(() => syncEventSigningPayload(new Date())).toThrow(TypeError);
    expect(() => syncEventSigningPayload("event")).toThrow(TypeError);
  });

  it("refuses values JSON cannot represent exactly", () => {
    expect(() => syncEventSigningPayload({ amount: Number.NaN })).toThrow(TypeError);
    expect(() => syncEventSigningPayload({ when: () => 1 })).toThrow(TypeError);
  });
});

describe("sync request", () => {
  it("limits the batch size", () => {
    expect(syncRequestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ events: Array.from({ length: MAX_SYNC_BATCH }, () => ({})) }).success).toBe(true);
    expect(syncRequestSchema.safeParse({ events: Array.from({ length: MAX_SYNC_BATCH + 1 }, () => ({})) }).success).toBe(false);
  });
});

describe("sync results", () => {
  it("builds results whose status always matches the code", () => {
    for (const code of Object.keys(SYNC_RESULT_CODES) as (keyof typeof SYNC_RESULT_CODES)[]) {
      const result = syncResult(0, ids.event, code);
      expect(result.status).toBe(SYNC_RESULT_CODES[code]);
      expect(syncResponseSchema.parse({ results: [result] }).results[0]).toEqual(result);
    }
  });

  it("can report an event whose id was unreadable", () => {
    expect(syncResponseSchema.safeParse({ results: [syncResult(3, null, "INVALID_EVENT")] }).success).toBe(true);
  });

  it("only removes events from the queue on a known final status", () => {
    expect(isFinalSyncStatus("applied")).toBe(true);
    expect(isFinalSyncStatus("duplicate")).toBe(true);
    expect(isFinalSyncStatus("rejected")).toBe(true);
    expect(isFinalSyncStatus("retry_later")).toBe(false);
    expect(isFinalSyncStatus("held_by_a_newer_server")).toBe(false);
  });
});

describe("readSyncResponse", () => {
  it("returns one result per event in request order, matched by index", () => {
    const body = {
      results: [
        { index: 1, eventId: null, status: "rejected", code: "INVALID_EVENT" },
        { index: 0, eventId: ids.event, status: "applied", code: "OK" },
      ],
    };
    expect(readSyncResponse(2, body)).toEqual([
      { status: "applied", code: "OK" },
      { status: "rejected", code: "INVALID_EVENT" },
    ]);
  });

  it("keeps events queued when the server sends an unknown status, a malformed result or no result", () => {
    const body = {
      results: [
        { index: 0, eventId: ids.event, status: "parked", code: "NEW_THING" },
        { index: 1, status: 42 },
        { index: 9, eventId: null, status: "applied", code: "OK" },
      ],
    };
    const results = readSyncResponse(3, body);
    expect(results.map((result) => result.status)).toEqual(["retry_later", "retry_later", "retry_later"]);
    expect(results.every((result) => !isFinalSyncStatus(result.status))).toBe(true);
  });

  it("keeps every event queued when the body is not a response at all", () => {
    expect(readSyncResponse(2, "<html>502</html>")).toEqual([
      { status: "retry_later", code: "NO_RESULT" },
      { status: "retry_later", code: "NO_RESULT" },
    ]);
  });
});
