import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

let db: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  await admin.query("SET search_path = app");
});

afterAll(async () => {
  await admin.end();
  await db.cleanup();
});

const TOKEN_TABLES = ["owner_sessions", "password_reset_tokens", "owner_invites", "device_tokens", "pairing_codes", "customer_recovery_tokens"] as const;

/** A café with an owner and a device, and one expired and one live row of each of its credential tables. */
async function cafeWithCredentials(): Promise<void> {
  const cafeId = randomUUID();
  const ownerId = randomUUID();
  const deviceId = randomUUID();
  await admin.query("INSERT INTO cafes (id, name) VALUES ($1, 'Café')", [cafeId]);
  await admin.query("INSERT INTO owners (id, cafe_id, email, password_hash) VALUES ($1, $2, $3, '$argon2id$fixture')", [ownerId, cafeId, `${ownerId}@example.com`]);
  await admin.query("INSERT INTO devices (id, cafe_id, name) VALUES ($1, $2, 'Counter')", [deviceId, cafeId]);
  for (const expires of ["now() - interval '1 minute'", "now() + interval '1 hour'"]) {
    await admin.query(`INSERT INTO owner_sessions (cafe_id, owner_id, token_hash, expires_at) VALUES ($1, $2, $3, ${expires})`, [cafeId, ownerId, randomBytes(32)]);
    await admin.query(`INSERT INTO password_reset_tokens (cafe_id, owner_id, token_hash, expires_at) VALUES ($1, $2, $3, ${expires})`, [cafeId, ownerId, randomBytes(32)]);
    await admin.query(`INSERT INTO owner_invites (cafe_id, token_hash, expires_at) VALUES ($1, $2, ${expires})`, [cafeId, randomBytes(32)]);
    await admin.query(`INSERT INTO device_tokens (cafe_id, device_id, token_hash, expires_at) VALUES ($1, $2, $3, ${expires})`, [cafeId, deviceId, randomBytes(32)]);
    await admin.query(
      `INSERT INTO pairing_codes (cafe_id, owner_id, device_name, lookup_hash, secret_hash, expires_at) VALUES ($1, $2, 'Counter 2', $3, $4, ${expires})`,
      [cafeId, ownerId, randomBytes(32), randomBytes(32)],
    );
  }
  // Idle a minute longer than a session may be (SESSION_IDLE_TIMEOUT_SECONDS, 7 days), though not past its absolute
  // end; and idle a minute less, which the server still accepts.
  for (const idle of ["604800 + 60", "604800 - 60"]) {
    await admin.query(
      `INSERT INTO owner_sessions (cafe_id, owner_id, token_hash, expires_at, last_seen_at) VALUES ($1, $2, $3, now() + interval '20 days', now() - make_interval(secs => ${idle}))`,
      [cafeId, ownerId, randomBytes(32)],
    );
  }
}

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TOKEN_TABLES) {
    const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    result[table] = rows[0]?.n ?? -1;
  }
  return result;
}

describe("purge_expired_credentials", () => {
  it("deletes expired and idle credentials of every café, and nothing that still works", async () => {
    await cafeWithCredentials();
    await cafeWithCredentials();
    for (const expires of ["now() - interval '1 minute'", "now() + interval '1 hour'"]) {
      await admin.query(`INSERT INTO customer_recovery_tokens (email_lookup, token_hash, expires_at) VALUES ($1, $2, ${expires})`, [randomBytes(32), randomBytes(32)]);
    }

    // As the app role, with no café set: it sees none of these rows itself, expired or not, and the policies that let
    // the purge see expired rows are the owner role's alone.
    for (const table of TOKEN_TABLES) {
      const { rows: visible } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(db.app.db);
      expect({ table, visible: visible[0]?.n }).toEqual({ table, visible: 0 });
    }
    const { rows: policies } = await admin.query<{ tablename: string; roles: string[] }>(
      "SELECT tablename, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'app' AND policyname = 'purge_expired' ORDER BY tablename COLLATE \"C\"",
    );
    expect(policies).toEqual([...TOKEN_TABLES].sort().map((tablename) => ({ tablename, roles: ["cl_owner"] })));

    const { rows } = await sql<{ table_name: string; deleted: string }>`SELECT table_name, deleted FROM purge_expired_credentials()`.execute(db.app.db);
    expect(Object.fromEntries(rows.map((row) => [row.table_name, Number(row.deleted)]))).toEqual({
      owner_sessions: 4,
      password_reset_tokens: 2,
      owner_invites: 2,
      device_tokens: 2,
      pairing_codes: 2,
      customer_recovery_tokens: 1,
    });
    expect(await counts()).toEqual({ owner_sessions: 4, password_reset_tokens: 2, owner_invites: 2, device_tokens: 2, pairing_codes: 2, customer_recovery_tokens: 1 });
  });
});
