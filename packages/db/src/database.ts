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

/** What a caller holds before any café is known: an owner's email (signing in) or a token hash (session, invite, reset). */
export type LookupKey = { ownerEmail: string } | { secretHash: Buffer };

const SECRET_HASH_BYTES = 32;

/**
 * Runs `work` in one read-only transaction with no café set, in which row-level security shows only the rows
 * matching `key`: the owner with that email, or the session, invite or reset token with that hash. It never shows
 * other rows and cannot write; follow up with withCafe on the café id it returns.
 */
export async function withLookup<T>(db: Kysely<Database>, key: LookupKey, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  let setting: string;
  let value: string;
  if ("ownerEmail" in key) {
    if (key.ownerEmail === "") {
      throw new TenantContextError("An owner email lookup must not be empty.");
    }
    [setting, value] = ["app.owner_email", key.ownerEmail];
  } else {
    if (key.secretHash.length !== SECRET_HASH_BYTES) {
      throw new TenantContextError("A secret hash must be 32 bytes.");
    }
    [setting, value] = ["app.secret_hash", key.secretHash.toString("hex")];
  }
  return db
    .transaction()
    .setAccessMode("read only")
    .execute(async (trx) => {
      await sql`SELECT set_config(${setting}, ${value}, true)`.execute(trx);
      return work(trx);
    });
}
