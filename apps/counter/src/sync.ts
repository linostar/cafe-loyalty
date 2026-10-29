import { MAX_SYNC_BATCH, isDeviceRevokedResponse, isFinalSyncStatus, readSyncResponse, syncEventSigningPayload } from "@cafe-loyalty/shared";
import { z } from "zod";
import { deviceRequestFor, signText, unpairDevice } from "./device.js";
import { addQueued, countQueued, getMeta, isHeld, listQueued, nextSequence, setMeta, settleQueued, type MetaValues, type RejectedEvent } from "./storage.js";

/**
 * Records an event in the queue, signed with the device key, so it is kept on the phone until the server has
 * answered it for good (AC 22). Works offline, and while the phone waits to be paired again. `at` is when it
 * happened: now, unless given (a visit passes the moment its discounts were priced). `holdMs` keeps it unsent that
 * long, so it can be taken back meanwhile (unqueue its `sequence` before `holdUntil`).
 */
export async function recordEvent(
  type: string,
  schemaVersion: number,
  staffId: string,
  payload: Record<string, unknown>,
  at: Date = new Date(),
  holdMs = 0,
): Promise<{ sequence: number; holdUntil: number }> {
  const device = await getMeta("device");
  if (device === undefined) {
    throw new Error("This phone is not paired yet, so it cannot record anything. Pair it first.");
  }
  const sequence = await nextSequence();
  const fields = {
    eventId: crypto.randomUUID(),
    deviceId: device.deviceId,
    keyId: device.keyId,
    staffId,
    sequence,
    schemaVersion,
    type,
    occurredAt: at.toISOString(),
    payload,
  };
  const signature = await signText(device.privateKey, syncEventSigningPayload(fields));
  const holdUntil = Date.now() + holdMs;
  await addQueued({ sequence, eventId: fields.eventId, type, occurredAt: fields.occurredAt, event: { ...fields, signature }, ...(holdMs > 0 ? { holdUntil } : {}) });
  return { sequence, holdUntil };
}

export interface SyncSummary {
  /** Events the server answered for good this time. */
  settled: number;
  /** Events still queued, to send later. */
  remaining: number;
  /** When the first event still held (unsent until then, so it can be taken back) may be sent, if one is. */
  heldUntil?: number;
}

/**
 * Sends the queue, oldest first, a batch at a time. An event leaves the queue only on applied, duplicate or rejected;
 * a rejected one moves to the error list; anything else (retry_later, no answer, an unknown status) stays (AC 23).
 * Stops at the first batch with an event that must wait, and throws on a failed request, keeping every event. A
 * response saying the device was removed unpairs it (DeviceUnpairedError) once that batch is settled. A held event is
 * never sent before its time, and nothing after it is either, so the queue keeps its order.
 */
async function drain(): Promise<SyncSummary> {
  let settled = 0;
  for (;;) {
    // Read before the queue is: an Undo whose transaction runs after this listing reads a later time, so it never takes
    // back an event this batch sends.
    const now = Date.now();
    const queued = await listQueued(MAX_SYNC_BATCH);
    const firstHeld = queued.findIndex((entry) => isHeld(entry, now));
    const batch = firstHeld === -1 ? queued : queued.slice(0, firstHeld);
    const heldUntil = firstHeld === -1 ? undefined : queued[firstHeld]?.holdUntil;
    if (batch.length === 0) {
      return heldUntil === undefined ? { settled, remaining: 0 } : { settled, remaining: await countQueued(), heldUntil };
    }
    const { body, keyId } = await deviceRequestFor("POST", "/api/device/sync", z.unknown(), { events: batch.map((entry) => entry.event) });
    const results = readSyncResponse(batch.length, body);
    const done: number[] = [];
    const rejected: RejectedEvent[] = [];
    const rejectedAt = new Date().toISOString();
    let lastVisit: MetaValues["lastVisit"] | undefined;
    results.forEach((result, index) => {
      const entry = batch[index];
      if (entry === undefined || !isFinalSyncStatus(result.status)) {
        return;
      }
      done.push(entry.sequence);
      if (result.status === "rejected") {
        rejected.push({ eventId: entry.eventId, type: entry.type, occurredAt: entry.occurredAt, code: result.code, rejectedAt });
      } else if (entry.type === "visit.recorded") {
        // Applied, or a duplicate: an earlier send was applied and its answer lost. The server keeps no first code for a
        // duplicate, so the counter says only that it was recorded, rather than keep saying the visit before it.
        lastVisit = { eventId: entry.eventId, occurredAt: entry.occurredAt, code: result.code };
      }
    });
    await settleQueued(done, rejected);
    if (lastVisit !== undefined) {
      await setMeta("lastVisit", lastVisit);
    }
    settled += done.length;
    // The owner removed this phone: what it sent is held for review, and it unpairs now (AC 21).
    if (isDeviceRevokedResponse(body)) {
      return unpairDevice(keyId, "revoked");
    }
    if (done.length < batch.length) {
      return { settled, remaining: await countQueued() };
    }
    if (heldUntil !== undefined) {
      return { settled, remaining: await countQueued(), heldUntil };
    }
  }
}

let running: Promise<SyncSummary> | undefined;

/** Syncs the queue; a call while a sync is running joins it. */
export function syncQueue(): Promise<SyncSummary> {
  running ??= drain().finally(() => {
    running = undefined;
  });
  return running;
}
