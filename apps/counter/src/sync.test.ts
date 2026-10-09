import { MAX_SYNC_BATCH, syncEventSigningPayload } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { countQueued, getMeta, listQueued, listRejected } from "./storage.js";
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
