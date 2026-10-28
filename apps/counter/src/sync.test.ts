import { MAX_SYNC_BATCH, syncEventSigningPayload } from "@cafe-loyalty/shared";
import { describe, expect, it, vi } from "vitest";
import { countQueued, getMeta, listQueued, listRejected, unqueue } from "./storage.js";
import { recordEvent, syncQueue } from "./sync.js";
import { fakeApi, storePairedDevice, verifies } from "./test-helpers.js";

const STAFF_ID = "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e";
const LOCKOUT = { failedAttempts: 5, lockedUntil: "2026-10-01T00:00:30.000Z" };

async function record(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await recordEvent("staff.pin_lockout", 1, STAFF_ID, LOCKOUT);
  }
}

describe("recordEvent", () => {
  it("queues events signed by the device key, with the device's ids and a rising sequence (AC 22)", async () => {
    const { device, publicKey } = await storePairedDevice();
    await record(2);
    const queued = await listQueued(10);
    expect(queued.map((entry) => entry.sequence)).toEqual([1, 2]);
    for (const { event } of queued) {
      expect(event).toMatchObject({ deviceId: device.deviceId, keyId: device.keyId, staffId: STAFF_ID, schemaVersion: 1, type: "staff.pin_lockout", payload: LOCKOUT });
      expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await verifies(publicKey, String(event.signature), syncEventSigningPayload(event))).toBe(true);
    }
  });

  it("refuses to record before the phone is paired", async () => {
    await expect(record(1)).rejects.toThrow(/not paired/);
  });
});

describe("syncQueue", () => {
  it("removes events only on a final status and lists the rejected ones (AC 23)", async () => {
    await storePairedDevice();
    await record(6);
    fakeApi(() => ({
      status: 200,
      body: {
        results: [
          { index: 0, eventId: null, status: "applied", code: "OK" },
          { index: 1, eventId: null, status: "duplicate", code: "DUPLICATE" },
          { index: 2, eventId: null, status: "rejected", code: "CLOCK_SKEW" },
          { index: 3, eventId: null, status: "retry_later", code: "UNSUPPORTED_EVENT" },
          { index: 4, eventId: null, status: "from_the_future", code: "NEW" },
          // Index 5 gets no result at all.
        ],
      },
    }));
    expect(await syncQueue()).toEqual({ settled: 3, remaining: 3 });
    expect((await listQueued(10)).map((entry) => entry.sequence)).toEqual([4, 5, 6]);
    expect(await listRejected()).toMatchObject([{ type: "staff.pin_lockout", code: "CLOCK_SKEW" }]);
  });

  it("unpairs at once when the answer says the owner removed the phone, after settling what it sent (AC 21)", async () => {
    await storePairedDevice();
    await record(1);
    fakeApi(() => ({ status: 200, body: { results: [{ index: 0, eventId: null, status: "applied", code: "HELD_FOR_REVIEW" }], deviceRevoked: true } }));
    await expect(syncQueue()).rejects.toMatchObject({ name: "DeviceUnpairedError", reason: "revoked" });
    expect(await countQueued()).toBe(0);
    expect(await getMeta("device")).toMatchObject({ paired: false, unpairedReason: "revoked" });
  });

  it("keeps every event when the request fails", async () => {
    await storePairedDevice();
    await record(2);
    fakeApi(() => ({ status: 503, body: "<html>Service unavailable</html>" }));
    await expect(syncQueue()).rejects.toMatchObject({ failure: { retryable: true } });
    expect(await countQueued()).toBe(2);
  });

  it("sends nothing from a held event on until its time, so it can be taken back meanwhile, and only while held (K2)", async () => {
    await storePairedDevice();
    await record(1);
    const held = await recordEvent("visit.recorded", 3, STAFF_ID, { card: { kind: "phone", phone: "+96170123456" } }, new Date(), 10_000);
    await record(1);
    const calls = fakeApi((call) => {
      const events = (call.body as { events: unknown[] }).events;
      return { status: 200, body: { results: events.map((_, index) => ({ index, eventId: null, status: "applied", code: "OK" })) } };
    });
    // Only what was queued before it; the event after it waits too, so the queue keeps its order.
    expect(await syncQueue()).toEqual({ settled: 1, remaining: 2, heldUntil: held.holdUntil });
    expect(calls.map((call) => (call.body as { events: { sequence: number }[] }).events.map((event) => event.sequence))).toEqual([[1]]);
    expect(await syncQueue()).toEqual({ settled: 0, remaining: 2, heldUntil: held.holdUntil });
    expect(calls).toHaveLength(1);
    // Taken back while held; not once its time has come (then it may be on its way).
    const now = vi.spyOn(Date, "now").mockReturnValue(held.holdUntil);
    expect(await unqueue(held.sequence)).toBe(false);
    now.mockReturnValue(held.holdUntil - 1);
    expect(await unqueue(held.sequence)).toBe(true);
    expect(await unqueue(held.sequence)).toBe(false);
    now.mockRestore();
    expect(await syncQueue()).toEqual({ settled: 1, remaining: 0 });
    expect(calls[1]?.body).toMatchObject({ events: [{ sequence: 3 }] });
  });

  it("never sends a visit that an Undo racing the sync takes back, even as its hold ends between them (K2)", async () => {
    await storePairedDevice();
    const held = await recordEvent("visit.recorded", 3, STAFF_ID, { card: { kind: "phone", phone: "+96170123456" } }, new Date(), 10_000);
    const calls = fakeApi((call) => {
      const events = (call.body as { events: unknown[] }).events;
      return { status: 200, body: { results: events.map((_, index) => ({ index, eventId: null, status: "applied", code: "OK" })) } };
    });
    // The sync starts a moment before the hold ends, and the tap comes as it ends, while the sync lists the queue.
    const now = vi.spyOn(Date, "now").mockReturnValue(held.holdUntil - 1);
    const syncing = syncQueue();
    now.mockReturnValue(held.holdUntil);
    const taken = await unqueue(held.sequence);
    const summary = await syncing;
    const sent = calls.some((call) => (call.body as { events: { sequence: number }[] }).events.some((event) => event.sequence === held.sequence));
    expect({ taken, sent }).toEqual({ taken: false, sent: false });
    expect(summary).toEqual({ settled: 0, remaining: 1, heldUntil: held.holdUntil });
  });

  it("ends a hold the clock was set back past, so the queue never waits on it (K2)", async () => {
    await storePairedDevice();
    const held = await recordEvent("visit.recorded", 3, STAFF_ID, { card: { kind: "phone", phone: "+96170123456" } }, new Date(), 10_000);
    await record(1);
    const calls = fakeApi((call) => {
      const events = (call.body as { events: unknown[] }).events;
      return { status: 200, body: { results: events.map((_, index) => ({ index, eventId: null, status: "applied", code: "OK" })) } };
    });
    // Corrected back by an hour: the hold now looks an hour away.
    vi.spyOn(Date, "now").mockReturnValue(held.holdUntil - 10_000 - 60 * 60 * 1000);
    expect(await unqueue(held.sequence)).toBe(false);
    expect(await syncQueue()).toEqual({ settled: 2, remaining: 0 });
    expect(calls).toHaveLength(1);
  });

  it("keeps the server's answer to the last visit it settled, to say why it got no stamps (K1)", async () => {
    await storePairedDevice();
    const at = new Date("2026-10-01T08:00:00.000Z");
    await recordEvent("visit.recorded", 3, STAFF_ID, {}, at);
    await recordEvent("visit.recorded", 3, STAFF_ID, {}, new Date("2026-10-01T08:05:00.000Z"));
    await record(1);
    fakeApi(() => ({
      status: 200,
      body: {
        results: [
          { index: 0, eventId: null, status: "applied", code: "OK" },
          { index: 1, eventId: null, status: "applied", code: "STAMP_COOLDOWN" },
          { index: 2, eventId: null, status: "applied", code: "OK" },
        ],
      },
    }));
    await syncQueue();
    // The second visit's answer: the lockout report after it is not a visit.
    expect(await getMeta("lastVisit")).toMatchObject({ occurredAt: "2026-10-01T08:05:00.000Z", code: "STAMP_COOLDOWN" });
  });

  it("sends a long queue in batches, oldest first, one sync at a time", async () => {
    await storePairedDevice();
    await record(MAX_SYNC_BATCH + 5);
    const calls = fakeApi((call) => {
      const events = (call.body as { events: unknown[] }).events;
      return { status: 200, body: { results: events.map((_, index) => ({ index, eventId: null, status: "applied", code: "OK" })) } };
    });
    const [first, second] = await Promise.all([syncQueue(), syncQueue()]);
    expect(first).toEqual({ settled: MAX_SYNC_BATCH + 5, remaining: 0 });
    expect(second).toBe(first);
    expect(calls.map((call) => (call.body as { events: { sequence: number }[] }).events.map((event) => event.sequence))).toEqual([
      Array.from({ length: MAX_SYNC_BATCH }, (_, index) => index + 1),
      [101, 102, 103, 104, 105],
    ]);
  });
});
