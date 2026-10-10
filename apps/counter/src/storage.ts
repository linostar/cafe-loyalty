/**
 * The counter's IndexedDB database: the device's identity and token, the staff PIN hashes, the signed event queue,
 * the list of events the server rejected, and PIN lockouts (AC 19, 22, 23). A newer build opens what an older build
 * stored, so a change to any record's shape needs a version upgrade here. The service worker updates only once the
 * queue is empty (AC 29), but every other store survives an update.
 */

import type { DeviceCatalog } from "@cafe-loyalty/shared";

const DB_NAME = "cafe-loyalty-counter";
const DB_VERSION = 1;

export interface DeviceRecord {
  deviceId: string;
  keyId: string;
  /** Non-extractable ECDSA P-256 key (AC 17); it stays after unpairing, to prove the device's id when pairing again. */
  privateKey: CryptoKey;
  deviceName: string;
  cafe: { id: string; name: string };
  /** False after the server answered DEVICE_REVOKED or PAIRING_REQUIRED, until the device pairs again. */
  paired: boolean;
  unpairedReason: "revoked" | "pairing_required" | null;
}

export interface StoredToken {
  accessToken: string;
  expiresAt: string;
  /** The device key the token was issued for: a token of an earlier pairing is never used for a newer one. */
  keyId: string;
}

/** A barista as the device knows them: the PBKDF2 hash of their PIN, never the PIN (AC 19). */
export interface StaffEntry {
  id: string;
  name: string;
  pinSalt: string;
  pinHash: string;
  pinIterations: number;
}

export interface QueuedEvent {
  /** The event's per-device sequence number, which orders the queue. */
  sequence: number;
  eventId: string;
  type: string;
  occurredAt: string;
  /** The signed event exactly as it is sent. */
  event: Record<string, unknown>;
}

/** An event the server refused for good, kept in the error list until someone clears it (AC 23). */
export interface RejectedEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  code: string;
  rejectedAt: string;
}

/** Wrong PINs in a row for one barista on this device, and until when no PIN is checked (AC 19). */
export interface Lockout {
  staffId: string;
  failures: number;
  lockedUntil: number | null;
}

export interface MetaValues {
  device: DeviceRecord;
  token: StoredToken;
  staff: StaffEntry[];
  /** The last sequence number given to an event. */
  sequence: number;
  /** The barista signed in on this device, until someone switches. */
  barista: { staffId: string };
  /** The issuedAt (ms) of the last renewal sent, shared by every tab: the server refuses one that is not later. */
  lastIssuedAt: number;
  /** The order types on sale and the reward, for recording visits offline. */
  /** Builds before campaigns (Step 12) stored no campaigns or time zone. */
  catalog: Omit<DeviceCatalog, "timeZone" | "campaigns"> & Partial<Pick<DeviceCatalog, "timeZone" | "campaigns">>;
  /**
   * A redemption sent without a confirmed answer: kept until it gets one, so trying again (even after a reload or an
   * update) reuses its event id and can never give the reward twice (AC 31).
   */
  /** A reward sent without a confirmed answer; startedAt (ISO) tells the barista which customer it was for. */
  pendingRedemption: { eventId: string; cardQr: string; startedAt: string };
}

type MetaKey = keyof MetaValues;

const META = "meta";
const QUEUE = "queue";
const REJECTED = "rejected";
const LOCKOUTS = "lockouts";

let opening: Promise<IDBDatabase> | undefined;
const listeners = new Set<() => void>();
/** Tells the counter's other tabs about changes, so a tab never acts on what another tab replaced (unpaired, re-paired). */
let channel: BroadcastChannel | undefined;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("An IndexedDB request failed."));
    };
  });
}

function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(META);
      db.createObjectStore(QUEUE, { keyPath: "sequence" });
      db.createObjectStore(REJECTED, { keyPath: "eventId" });
      db.createObjectStore(LOCKOUTS, { keyPath: "staffId" });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) {
        // Opened after this attempt gave up (blocked): close it, so it does not block the next upgrade.
        db.close();
        return;
      }
      // A newer build in another tab upgrades the database: let it, and reload into that build.
      db.onversionchange = () => {
        db.close();
        opening = undefined;
        window.location.reload();
      };
      resolve(db);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Could not open this phone's storage."));
    };
    request.onblocked = () => {
      abandoned = true;
      reject(new Error("This phone's storage is busy in another tab. Close the other counter tabs and reload."));
    };
  }).catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

/** Runs `work` in one transaction and resolves with its result once the transaction has committed. */
async function transact<T>(stores: string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await database();
  const transaction = db.transaction(stores, mode);
  const committed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Could not save to this phone's storage."));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("Saving to this phone's storage was cancelled."));
    };
  });
  let result: T;
  try {
    result = await work(transaction);
  } catch (error) {
    // The original error is the one to report; the abort's own rejection adds nothing.
    committed.catch(() => undefined);
    try {
      transaction.abort();
    } catch {
      // The transaction had already finished; the original error is still thrown.
    }
    throw error;
  }
  await committed;
  if (mode === "readwrite") {
    notify();
    channel?.postMessage("changed");
  }
  return result;
}

/** Calls `listener` after every change to the stored data; returns the unsubscribe function. */
export function onStorageChange(listener: () => void): () => void {
  if (channel === undefined && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(DB_NAME);
    channel.onmessage = notify;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMeta<K extends MetaKey>(key: K): Promise<MetaValues[K] | undefined> {
  return transact([META], "readonly", (transaction) => promised(transaction.objectStore(META).get(key) as IDBRequest<MetaValues[K] | undefined>));
}

export async function setMeta<K extends MetaKey>(key: K, value: MetaValues[K]): Promise<void> {
  await transact([META], "readwrite", (transaction) => promised(transaction.objectStore(META).put(value, key)));
}

export async function deleteMeta(...keys: MetaKey[]): Promise<void> {
  await transact([META], "readwrite", async (transaction) => {
    for (const key of keys) {
      await promised(transaction.objectStore(META).delete(key));
    }
  });
}

/**
 * Saves a pairing in one step: the device and its first token, without the baristas when the café changed, and
 * without the queue when the phone started over (its events belonged to another café).
 */
export async function storePairing(device: DeviceRecord, token: StoredToken, options: { forgetStaff: boolean; forgetQueue: boolean }): Promise<void> {
  await transact([META, QUEUE], "readwrite", async (transaction) => {
    const meta = transaction.objectStore(META);
    await promised(meta.put(device, "device"));
    await promised(meta.put(token, "token"));
    if (options.forgetStaff) {
      await promised(meta.delete("staff"));
      await promised(meta.delete("barista"));
      await promised(meta.delete("catalog"));
    }
    if (options.forgetQueue) {
      await promised(transaction.objectStore(QUEUE).clear());
    }
  });
}

/** Stores a renewed token, unless the phone was paired again with another key meanwhile (then the token is dropped). */
export function storeToken(token: StoredToken): Promise<boolean> {
  return transact([META], "readwrite", async (transaction) => {
    const meta = transaction.objectStore(META);
    const device = await promised(meta.get("device") as IDBRequest<DeviceRecord | undefined>);
    if (device?.paired !== true || device.keyId !== token.keyId) {
      return false;
    }
    await promised(meta.put(token, "token"));
    return true;
  });
}

/**
 * Marks the device of key `keyId` unpaired, keeping its key and queue; a removed device also forgets the PIN hashes and
 * the barista (AC 21). Does nothing when the phone was paired again with another key meanwhile.
 */
export function storeUnpaired(keyId: string, reason: "revoked" | "pairing_required"): Promise<boolean> {
  return transact([META], "readwrite", async (transaction) => {
    const meta = transaction.objectStore(META);
    const device = await promised(meta.get("device") as IDBRequest<DeviceRecord | undefined>);
    if (device?.keyId !== keyId) {
      return false;
    }
    await promised(meta.put({ ...device, paired: false, unpairedReason: reason }, "device"));
    await promised(meta.delete("token"));
    if (reason === "revoked") {
      await promised(meta.delete("staff"));
      await promised(meta.delete("barista"));
      await promised(meta.delete("catalog"));
    }
    return true;
  });
}

/**
 * Stores the baristas the server sent for the device of key `keyId`, unless the phone was paired again meanwhile, and
 * signs out a barista who is no longer among them. Returns whether it stored them.
 */
export function storeStaff(keyId: string, staff: StaffEntry[]): Promise<boolean> {
  return transact([META], "readwrite", async (transaction) => {
    const meta = transaction.objectStore(META);
    const device = await promised(meta.get("device") as IDBRequest<DeviceRecord | undefined>);
    if (device?.paired !== true || device.keyId !== keyId) {
      return false;
    }
    await promised(meta.put(staff, "staff"));
    const barista = await promised(meta.get("barista") as IDBRequest<{ staffId: string } | undefined>);
    if (barista !== undefined && !staff.some((member) => member.id === barista.staffId)) {
      await promised(meta.delete("barista"));
    }
    return true;
  });
}

/** Stores the catalog the server sent for the device of key `keyId`, unless the phone was paired again meanwhile. */
export function storeCatalog(keyId: string, catalog: DeviceCatalog): Promise<boolean> {
  return transact([META], "readwrite", async (transaction) => {
    const meta = transaction.objectStore(META);
    const device = await promised(meta.get("device") as IDBRequest<DeviceRecord | undefined>);
    if (device?.paired !== true || device.keyId !== keyId) {
      return false;
    }
    await promised(meta.put(catalog, "catalog"));
    return true;
  });
}

export type PinCount = { status: "locked"; lockedUntil: number } | { status: "counted"; failures: number; lockedUntil: number | null };

/**
 * Starts a PIN attempt in one step, before the PIN is checked: refuses it while the barista is locked out, and
 * otherwise counts it as a failure (with the lockout `delayFor` gives), so attempts from several tabs at once are
 * each counted. A PIN that then matches clears the count (deleteLockout).
 */
export function countPinAttempt(staffId: string, now: number, delayFor: (failures: number) => number): Promise<PinCount> {
  return transact([LOCKOUTS], "readwrite", async (transaction): Promise<PinCount> => {
    const store = transaction.objectStore(LOCKOUTS);
    const lockout = await promised(store.get(staffId) as IDBRequest<Lockout | undefined>);
    if (lockout?.lockedUntil != null && lockout.lockedUntil > now) {
      return { status: "locked", lockedUntil: lockout.lockedUntil };
    }
    const failures = (lockout?.failures ?? 0) + 1;
    const delay = delayFor(failures);
    const lockedUntil = delay === 0 ? null : now + delay;
    await promised(store.put({ staffId, failures, lockedUntil }));
    return { status: "counted", failures, lockedUntil };
  });
}

/** Takes the next renewal time: now, or just after the last one any tab sent. */
export function nextIssuedAt(): Promise<number> {
  return transact([META], "readwrite", async (transaction) => {
    const meta = transaction.objectStore(META);
    const last = (await promised(meta.get("lastIssuedAt") as IDBRequest<number | undefined>)) ?? 0;
    const next = Math.max(Date.now(), last + 1);
    await promised(meta.put(next, "lastIssuedAt"));
    return next;
  });
}

/** Takes the next per-device sequence number (AC 22); never reused, even when the event is not saved. */
export function nextSequence(): Promise<number> {
  return transact([META], "readwrite", async (transaction) => {
    const store = transaction.objectStore(META);
    const last = (await promised(store.get("sequence") as IDBRequest<number | undefined>)) ?? 0;
    await promised(store.put(last + 1, "sequence"));
    return last + 1;
  });
}

export async function addQueued(event: QueuedEvent): Promise<void> {
  await transact([QUEUE], "readwrite", (transaction) => promised(transaction.objectStore(QUEUE).add(event)));
}

/** The oldest queued events, in sequence order. */
export function listQueued(limit: number): Promise<QueuedEvent[]> {
  return transact([QUEUE], "readonly", (transaction) => promised(transaction.objectStore(QUEUE).getAll(null, limit) as IDBRequest<QueuedEvent[]>));
}

export function countQueued(): Promise<number> {
  return transact([QUEUE], "readonly", (transaction) => promised(transaction.objectStore(QUEUE).count()));
}

/** Removes events the server answered for good and adds the rejected ones to the error list, in one step. */
export async function settleQueued(sequences: readonly number[], rejected: readonly RejectedEvent[]): Promise<void> {
  await transact([QUEUE, REJECTED], "readwrite", async (transaction) => {
    for (const sequence of sequences) {
      await promised(transaction.objectStore(QUEUE).delete(sequence));
    }
    for (const entry of rejected) {
      await promised(transaction.objectStore(REJECTED).put(entry));
    }
  });
}

export async function listRejected(): Promise<RejectedEvent[]> {
  const entries = await transact([REJECTED], "readonly", (transaction) => promised(transaction.objectStore(REJECTED).getAll() as IDBRequest<RejectedEvent[]>));
  return entries.sort((a, b) => a.rejectedAt.localeCompare(b.rejectedAt));
}

export async function clearRejected(): Promise<void> {
  await transact([REJECTED], "readwrite", (transaction) => promised(transaction.objectStore(REJECTED).clear()));
}

export function getLockout(staffId: string): Promise<Lockout | undefined> {
  return transact([LOCKOUTS], "readonly", (transaction) => promised(transaction.objectStore(LOCKOUTS).get(staffId) as IDBRequest<Lockout | undefined>));
}

export async function deleteLockout(staffId: string): Promise<void> {
  await transact([LOCKOUTS], "readwrite", (transaction) => promised(transaction.objectStore(LOCKOUTS).delete(staffId)));
}

/** Closes the connection, so the next call opens the database afresh (tests replace the IndexedDB factory). */
export async function closeStorage(): Promise<void> {
  channel?.close();
  channel = undefined;
  const current = opening;
  opening = undefined;
  if (current !== undefined) {
    (await current).close();
  }
}
