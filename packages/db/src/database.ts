import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { z } from "zod";
import type { Database } from "./schema.js";

export interface DatabaseConfig {
  /** Connection URL of a login role that is a member of cl_app (never the owner role). */
  connectionString: string;
  applicationName: string;
  maxConnections: number;
  /** Fail a connection attempt after this long. */
  connectionTimeoutMs: number;
  /** Cancel any statement that runs longer than this. */
  statementTimeoutMs: number;
  /** End a session that sits idle inside an open transaction (holding locks) for longer than this. */
  idleInTransactionTimeoutMs: number;
  idleTimeoutMs: number;
  /** Called when an idle pooled connection fails (for example the database restarted). */
  onPoolError: (error: Error) => void;
}

export interface DatabaseHandle {
  db: Kysely<Database>;
  close(): Promise<void>;
}

/** Opens a connection pool with timeouts on connecting and on every statement, searching only schema `app`. */
export function createDatabase(config: DatabaseConfig): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    application_name: config.applicationName,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs,
    query_timeout: config.statementTimeoutMs + 1_000,
    options: "-c search_path=app",
  });
  pool.on("error", config.onPoolError);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, close: () => db.destroy() };
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

const cafeIdSchema = z.uuid();

/**
 * Runs `work` in one transaction scoped to `cafeId`: row-level security then shows and accepts only that café's
 * rows (AC 2). `cafeId` must come from the authenticated session, device or job record, never from request input.
 * The setting is transaction-local, so a pooled connection never carries it into the next transaction.
 */
export async function withCafe<T>(db: Kysely<Database>, cafeId: string, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  if (!cafeIdSchema.safeParse(cafeId).success) {
    throw new TenantContextError("A café id must be a UUID.");
  }
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.cafe_id', ${cafeId.toLowerCase()}, true)`.execute(trx);
    return work(trx);
  });
}

/**
 * What a caller holds before any café is known: an owner's or operator's email (signing in), a hash (session, invite, reset,
 * device token, pairing code lookup part, café join code, card web secret, recovery token, or the HMAC of a phone
 * number or recovery email), a device's key id (renewing its token) or a customer's id (only once the caller has
 * proved control of that customer's card).
 */
export type LookupKey = { ownerEmail: string } | { operatorEmail: string } | { secretHash: Buffer } | { deviceKeyId: string } | { customerId: string };

const SECRET_HASH_BYTES = 32;

/**
 * Runs `work` in one transaction with no café set, in which row-level security shows only the rows matching `key`:
 * the owner or operator with that email, the row with that hash, the device key or the customer with that id. Read-only by
 * default; "read write" only where a policy keyed on that same value allows writes (customer recovery tokens, an
 * operator's own row) or
 * where the work then switches to the cafés of rows it found (useCafe, customer recovery). Otherwise follow up with
 * withCafe on the café id it returns.
 */
export async function withLookup<T>(
  db: Kysely<Database>,
  key: LookupKey,
  work: (trx: Transaction<Database>) => Promise<T>,
  access: "read only" | "read write" = "read only",
): Promise<T> {
  return db
    .transaction()
    .setAccessMode(access)
    .execute(async (trx) => {
      await setLookup(trx, key);
      return work(trx);
    });
}

/**
 * Sets a lookup key inside a transaction that is already open (for example withCafe's, when signup checks a phone
 * number). Replaces any earlier key of the same kind for the rest of the transaction.
 */
export async function setLookup(trx: Transaction<Database>, key: LookupKey): Promise<void> {
  let setting: string;
  let value: string;
  if ("ownerEmail" in key) {
    if (key.ownerEmail === "") {
      throw new TenantContextError("An owner email lookup must not be empty.");
    }
    [setting, value] = ["app.owner_email", key.ownerEmail];
  } else if ("operatorEmail" in key) {
    if (key.operatorEmail === "") {
      throw new TenantContextError("An operator email lookup must not be empty.");
    }
    [setting, value] = ["app.operator_email", key.operatorEmail];
  } else if ("deviceKeyId" in key) {
    if (!cafeIdSchema.safeParse(key.deviceKeyId).success) {
      throw new TenantContextError("A device key id must be a UUID.");
    }
    [setting, value] = ["app.device_key_id", key.deviceKeyId.toLowerCase()];
  } else if ("customerId" in key) {
    if (!cafeIdSchema.safeParse(key.customerId).success) {
      throw new TenantContextError("A customer id must be a UUID.");
    }
    [setting, value] = ["app.customer_id", key.customerId.toLowerCase()];
  } else {
    if (key.secretHash.length !== SECRET_HASH_BYTES) {
      throw new TenantContextError("A secret hash must be 32 bytes.");
    }
    [setting, value] = ["app.secret_hash", key.secretHash.toString("hex")];
  }
  await sql`SELECT set_config(${setting}, ${value}, true)`.execute(trx);
}

/**
 * Runs `work` in one transaction acting for the operator `operatorId` (AC 39): row-level security then shows and
 * accepts that operator's own account and sessions, and no café's rows. `operatorId` must come from a checked
 * operator session or sign-in. A café the operator acts on is read and changed in its own withCafe.
 */
export async function withOperator<T>(db: Kysely<Database>, operatorId: string, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  if (!cafeIdSchema.safeParse(operatorId).success) {
    throw new TenantContextError("An operator id must be a UUID.");
  }
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.operator_id', ${operatorId.toLowerCase()}, true)`.execute(trx);
    return work(trx);
  });
}

/**
 * Switches the café of an open transaction. Only for one customer's own cards across cafés (card recovery and
 * deletion), with café ids read from those cards after the customer proved control of them; everything else uses
 * one withCafe per café.
 */
export async function useCafe(trx: Transaction<Database>, cafeId: string): Promise<void> {
  if (!cafeIdSchema.safeParse(cafeId).success) {
    throw new TenantContextError("A café id must be a UUID.");
  }
  await sql`SELECT set_config('app.cafe_id', ${cafeId.toLowerCase()}, true)`.execute(trx);
}
