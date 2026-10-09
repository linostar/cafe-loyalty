/**
 * The counter's IndexedDB database: the device's identity and token, the staff PIN hashes, the signed event queue,
 * the list of events the server rejected, and PIN lockouts (AC 19, 22, 23). A newer build opens what an older build
 * stored, so a change to any record's shape needs a version upgrade here. The service worker updates only once the
 * queue is empty (AC 29), but every other store survives an update.
 */

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

interface MetaValues {
  device: DeviceRecord;
  token: StoredToken;
  staff: StaffEntry[];
  /** The last sequence number given to an event. */
  sequence: number;
  /** The barista signed in on this device, until someone switches. */
  barista: { staffId: string };
}

type MetaKey = keyof MetaValues;

const META = "meta";
const QUEUE = "queue";
const REJECTED = "rejected";
const LOCKOUTS = "lockouts";

let opening: Promise<IDBDatabase> | undefined;
const listeners = new Set<() => void>();

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
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(META);
      db.createObjectStore(QUEUE, { keyPath: "sequence" });
      db.createObjectStore(REJECTED, { keyPath: "eventId" });
      db.createObjectStore(LOCKOUTS, { keyPath: "staffId" });
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Could not open this phone's storage."));
    };
    request.onblocked = () => {
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
    for (const listener of listeners) {
      listener();
    }
  }
  return result;
}

/** Calls `listener` after every change to the stored data; returns the unsubscribe function. */
export function onStorageChange(listener: () => void): () => void {
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

export async function putLockout(lockout: Lockout): Promise<void> {
  await transact([LOCKOUTS], "readwrite", (transaction) => promised(transaction.objectStore(LOCKOUTS).put(lockout)));
}

export async function deleteLockout(staffId: string): Promise<void> {
  await transact([LOCKOUTS], "readwrite", (transaction) => promised(transaction.objectStore(LOCKOUTS).delete(staffId)));
}

/** Closes the connection, so the next call opens the database afresh (tests replace the IndexedDB factory). */
export async function closeStorage(): Promise<void> {
  const current = opening;
  opening = undefined;
  if (current !== undefined) {
    (await current).close();
  }
}
