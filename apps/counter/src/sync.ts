import { MAX_SYNC_BATCH, isDeviceRevokedResponse, isFinalSyncStatus, readSyncResponse, syncEventSigningPayload } from "@cafe-loyalty/shared";
import { z } from "zod";
import { deviceRequestFor, signText, unpairDevice } from "./device.js";
import { addQueued, countQueued, getMeta, listQueued, nextSequence, settleQueued, type RejectedEvent } from "./storage.js";

/**
 * Records an event in the queue, signed with the device key, so it is kept on the phone until the server has
 * answered it for good (AC 22). Works offline, and while the phone waits to be paired again. `at` is when it
 * happened: now, unless given (a visit passes the moment its discounts were priced).
 */
export async function recordEvent(type: string, schemaVersion: number, staffId: string, payload: Record<string, unknown>, at: Date = new Date()): Promise<void> {
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
  await addQueued({ sequence, eventId: fields.eventId, type, occurredAt: fields.occurredAt, event: { ...fields, signature } });
}

export interface SyncSummary {
  /** Events the server answered for good this time. */
  settled: number;
  /** Events still queued, to send later. */
  remaining: number;
}

/**
 * Sends the queue, oldest first, a batch at a time. An event leaves the queue only on applied, duplicate or rejected;
 * a rejected one moves to the error list; anything else (retry_later, no answer, an unknown status) stays (AC 23).
 * Stops at the first batch with an event that must wait, and throws on a failed request, keeping every event. A
 * response saying the device was removed unpairs it (DeviceUnpairedError) once that batch is settled.
 */
async function drain(): Promise<SyncSummary> {
  let settled = 0;
  for (;;) {
    const batch = await listQueued(MAX_SYNC_BATCH);
    if (batch.length === 0) {
      return { settled, remaining: 0 };
    }
    const { body, keyId } = await deviceRequestFor("POST", "/api/device/sync", z.unknown(), { events: batch.map((queued) => queued.event) });
    const results = readSyncResponse(batch.length, body);
    const done: number[] = [];
    const rejected: RejectedEvent[] = [];
    const rejectedAt = new Date().toISOString();
    results.forEach((result, index) => {
      const queued = batch[index];
      if (queued === undefined || !isFinalSyncStatus(result.status)) {
        return;
      }
      done.push(queued.sequence);
      if (result.status === "rejected") {
        rejected.push({ eventId: queued.eventId, type: queued.type, occurredAt: queued.occurredAt, code: result.code, rejectedAt });
      }
    });
    await settleQueued(done, rejected);
    settled += done.length;
    // The owner removed this phone: what it sent is held for review, and it unpairs now (AC 21).
    if (isDeviceRevokedResponse(body)) {
      return unpairDevice(keyId, "revoked");
    }
    if (done.length < batch.length) {
      return { settled, remaining: await countQueued() };
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
