import { randomBytes, randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContextError, createDatabase, withCafe } from "./database.js";
import { APP_GROUP_ROLE, OWNER_GROUP_ROLE } from "./roles.js";
import { TABLE_COLUMNS, TENANT_KEY, type Database, type TableName } from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

/** SQLSTATE 42501, insufficient_privilege: raised both by a row-level security WITH CHECK and by a missing grant. */
const PERMISSION_DENIED = "42501";
const INVALID_TEXT_REPRESENTATION = "22P02";

/** The owner each café's fixtures use, so a fixture written for café B under café A still names a real owner. */
const ownerIds = new Map<string, string>();
const ownerIdOf = (cafeId: string): string => {
  let id = ownerIds.get(cafeId);
  if (id === undefined) {
    id = randomUUID();
    ownerIds.set(cafeId, id);
  }
  return id;
};
const inOneHour = (): Date => new Date(Date.now() + 3_600_000);
/** The device each café's fixtures use, like ownerIdOf. */
const deviceIds = new Map<string, string>();
const deviceIdOf = (cafeId: string): string => {
  let id = deviceIds.get(cafeId);
  if (id === undefined) {
    id = randomUUID();
    deviceIds.set(cafeId, id);
  }
  return id;
};
/** The staff member and device key each café's fixtures use, like ownerIdOf. */
const staffIds = new Map<string, string>();
const staffIdOf = (cafeId: string): string => {
  let id = staffIds.get(cafeId);
  if (id === undefined) {
    id = randomUUID();
    staffIds.set(cafeId, id);
  }
  return id;
};
const keyIds = new Map<string, string>();
const keyIdOf = (cafeId: string): string => {
  let id = keyIds.get(cafeId);
  if (id === undefined) {
    id = randomUUID();
    keyIds.set(cafeId, id);
  }
  return id;
};
/** Ids each café's fixtures share between tables (order type, card, sync event, visit, Apple pass), like ownerIdOf. */
const sharedIds = new Map<string, string>();
const idOf = (kind: string, cafeId: string): string => {
  const key = `${kind}:${cafeId}`;
  let id = sharedIds.get(key);
  if (id === undefined) {
    id = randomUUID();
    sharedIds.set(key, id);
  }
  return id;
};
const PUBLIC_KEY = JSON.stringify({ kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) });

/** Tables without a café of their own (TENANT_KEY null), tested in customers.integration.test.ts. */
type GlobalTable = "customers" | "customer_recovery_tokens";

/** Inserts one row of each café table for a café, in this order. Every café table needs an entry (checked below). */
const FIXTURES: Readonly<Record<Exclude<TableName, "cafes" | GlobalTable>, (trx: Transaction<Database>, cafeId: string) => Promise<unknown>>> = {
  loyalty_programs: (trx, cafeId) =>
    trx
      .insertInto("loyalty_programs")
      .values({ cafe_id: cafeId, stamps_required: 9, reward_name_ar: "قهوة مجانية", reward_name_en: "Free coffee" })
      .execute(),
  order_types: (trx, cafeId) =>
    trx
      .insertInto("order_types")
      .values({ id: idOf("orderType", cafeId), cafe_id: cafeId, name_ar: "إسبريسو", name_en: "Espresso", price_cents: 250, cost_cents: 70 })
      .execute(),
  campaigns: (trx, cafeId) =>
    trx
      .insertInto("campaigns")
      .values({
        id: idOf("campaign", cafeId),
        cafe_id: cafeId,
        name_ar: "ساعات هادئة",
        name_en: "Quiet hours",
        weekdays: [1, 2, 3],
        starts_minute: 15 * 60,
        ends_minute: 17 * 60,
        discount_kind: "percent",
        discount_value: 20,
        min_margin_percent: 30,
      })
      .execute(),
  campaign_order_types: (trx, cafeId) =>
    trx.insertInto("campaign_order_types").values({ cafe_id: cafeId, campaign_id: idOf("campaign", cafeId), order_type_id: idOf("orderType", cafeId) }).execute(),
  audit_log: (trx, cafeId) =>
    trx
      .insertInto("audit_log")
      .values({ cafe_id: cafeId, actor_type: "system", action: "fixture.created", entity_type: "fixture", changes: JSON.stringify({ step: 4 }) })
      .execute(),
  owners: (trx, cafeId) =>
    trx
      .insertInto("owners")
      .values({ id: ownerIdOf(cafeId), cafe_id: cafeId, email: `owner-${cafeId}@example.com`, password_hash: "$argon2id$fixture" })
      .execute(),
  owner_invites: (trx, cafeId) =>
    trx.insertInto("owner_invites").values({ cafe_id: cafeId, token_hash: randomBytes(32), expires_at: inOneHour() }).execute(),
  owner_sessions: (trx, cafeId) =>
    trx
      .insertInto("owner_sessions")
      .values({ cafe_id: cafeId, owner_id: ownerIdOf(cafeId), token_hash: randomBytes(32), expires_at: inOneHour() })
      .execute(),
  password_reset_tokens: (trx, cafeId) =>
    trx
      .insertInto("password_reset_tokens")
      .values({ cafe_id: cafeId, owner_id: ownerIdOf(cafeId), token_hash: randomBytes(32), expires_at: inOneHour() })
      .execute(),
  staff: (trx, cafeId) =>
    trx
      .insertInto("staff")
      .values({ id: staffIdOf(cafeId), cafe_id: cafeId, name: "Rami", pin_salt: randomBytes(16), pin_hash: randomBytes(32), pin_iterations: 600_000 })
      .execute(),
  devices: (trx, cafeId) => trx.insertInto("devices").values({ id: deviceIdOf(cafeId), cafe_id: cafeId, name: "Counter" }).execute(),
  device_keys: (trx, cafeId) =>
    trx.insertInto("device_keys").values({ id: keyIdOf(cafeId), cafe_id: cafeId, device_id: deviceIdOf(cafeId), public_key: PUBLIC_KEY }).execute(),
  device_tokens: (trx, cafeId) =>
    trx
      .insertInto("device_tokens")
      .values({ cafe_id: cafeId, device_id: deviceIdOf(cafeId), token_hash: randomBytes(32), expires_at: inOneHour() })
      .execute(),
  pairing_codes: (trx, cafeId) =>
    trx
      .insertInto("pairing_codes")
      .values({
        cafe_id: cafeId,
        owner_id: ownerIdOf(cafeId),
        device_name: "Counter 2",
        lookup_hash: randomBytes(32),
        secret_hash: randomBytes(32),
        expires_at: inOneHour(),
      })
      .execute(),
  cards: (trx, cafeId) =>
    trx.insertInto("cards").values({ id: idOf("card", cafeId), cafe_id: cafeId, web_secret_hash: randomBytes(32), privacy_accepted_at: new Date() }).execute(),
  sync_events: (trx, cafeId) =>
    trx
      .insertInto("sync_events")
      .values({
        id: idOf("syncEvent", cafeId),
        cafe_id: cafeId,
        device_id: deviceIdOf(cafeId),
        event_id: randomUUID(),
        payload_hash: randomBytes(32),
        key_id: keyIdOf(cafeId),
        staff_id: staffIdOf(cafeId),
        type: "visit.recorded",
        schema_version: 1,
        sequence: 0,
        occurred_at: new Date(),
        status: "applied",
      })
      .execute(),
  visits: (trx, cafeId) =>
    trx
      .insertInto("visits")
      .values({
        id: idOf("visit", cafeId),
        cafe_id: cafeId,
        sync_event_id: idOf("syncEvent", cafeId),
        card_id: idOf("card", cafeId),
        identified_by: "qr",
        device_id: deviceIdOf(cafeId),
        staff_id: staffIdOf(cafeId),
        occurred_at: new Date(),
        total_cents: 250,
        stamps_earned: 1,
        stamps_added: 1,
        outcome: "stamped",
      })
      .execute(),
  visit_items: (trx, cafeId) =>
    trx
      .insertInto("visit_items")
      .values({
        cafe_id: cafeId,
        visit_id: idOf("visit", cafeId),
        line: 0,
        order_type_id: idOf("orderType", cafeId),
        quantity: 1,
        unit_price_cents: 250,
        unit_cost_cents: 70,
        catalog_version: 1,
        stamps_each: 1,
        campaign_id: idOf("campaign", cafeId),
        unit_discount_cents: 50,
      })
      .execute(),
  redemptions: (trx, cafeId) =>
    trx
      .insertInto("redemptions")
      .values({
        cafe_id: cafeId,
        device_id: deviceIdOf(cafeId),
        event_id: randomUUID(),
        card_id: idOf("card", cafeId),
        staff_id: staffIdOf(cafeId),
        stamps_used: 9,
        stamps_left: 0,
      })
      .execute(),
  apple_passes: (trx, cafeId) =>
    trx
      .insertInto("apple_passes")
      .values({ id: idOf("applePass", cafeId), cafe_id: cafeId, card_id: idOf("card", cafeId), epoch: 1, auth_token_hash: randomBytes(32), layout_version: 1 })
      .execute(),
  apple_pass_registrations: (trx, cafeId) =>
    trx
      .insertInto("apple_pass_registrations")
      .values({ cafe_id: cafeId, pass_id: idOf("applePass", cafeId), device_library_hash: randomBytes(32), push_token: "ab".repeat(32) })
      .execute(),
  google_passes: (trx, cafeId) => trx.insertInto("google_passes").values({ cafe_id: cafeId, card_id: idOf("card", cafeId), epoch: 1 }).execute(),
  card_lapses: (trx, cafeId) =>
    trx
      .insertInto("card_lapses")
      .values({
        cafe_id: cafeId,
        card_id: idOf("card", cafeId),
        last_visit_at: new Date("2026-09-01T10:00:00Z"),
        offered_at: new Date(),
        discount_kind: "percent",
        discount_value: 15,
        min_margin_percent: 30,
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      })
      .execute(),
  campaign_announcements: (trx, cafeId) =>
    trx.insertInto("campaign_announcements").values({ cafe_id: cafeId, campaign_id: idOf("campaign", cafeId), card_id: idOf("card", cafeId) }).execute(),
  feedback_requests: (trx, cafeId) =>
    trx
      .insertInto("feedback_requests")
      .values({ id: idOf("feedbackRequest", cafeId), cafe_id: cafeId, card_id: idOf("card", cafeId), visit_id: idOf("visit", cafeId) })
      .execute(),
  feedback: (trx, cafeId) => trx.insertInto("feedback").values({ cafe_id: cafeId, request_id: idOf("feedbackRequest", cafeId), message: "Fake feedback for the tenancy test." }).execute(),
};

const TABLES = Object.keys(TABLE_COLUMNS) as TableName[];
/** Every table scoped to one café, with the column that names it. */
const CAFE_TABLES = TABLES.flatMap((table) => {
  const key = TENANT_KEY[table];
  return key === null ? [] : [{ table: table as Exclude<TableName, GlobalTable>, key }];
});

let testDb: TestDatabase;
let admin: pg.Client;
const cafeA = randomUUID();
const cafeB = randomUUID();

async function seedCafe(cafeId: string, name: string): Promise<void> {
  await withCafe(testDb.app.db, cafeId, async (trx) => {
    await trx.insertInto("cafes").values({ id: cafeId, name }).execute();
    for (const fixture of Object.values(FIXTURES)) {
      await fixture(trx, cafeId);
    }
  });
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new pg.Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  await seedCafe(cafeA, "Café A");
  await seedCafe(cafeB, "Café B");
});

afterAll(async () => {
  await admin.end();
  await testDb.cleanup();
});

describe("catalog", () => {
  it("lists exactly the tables the code knows about in schema app", async () => {
    const { rows } = await admin.query<{ relname: string }>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') ORDER BY 1",
    );
    expect(rows.map((row) => row.relname)).toEqual([...TABLES].sort());
  });

  it("has a fixture for every café table", () => {
    expect([...Object.keys(FIXTURES), "cafes"].sort()).toEqual(CAFE_TABLES.map(({ table }) => table).sort());
  });

  it("forces row-level security with a café policy on every table, owned by the owner role", async () => {
    const { rows } = await admin.query<{ relname: string; enabled: boolean; forced: boolean; policies: number; owner: string }>(`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
             pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')`);
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({ enabled: true, forced: true, owner: OWNER_GROUP_ROLE });
      expect(row.policies, row.relname).toBeGreaterThan(0);
    }
  });
});

describe("roles", () => {
  it("connects the app as a login role without superuser or BYPASSRLS, outside the owner role", async () => {
    const { rows } = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean; in_app: boolean; in_owner: boolean }>(
      `SELECT rolsuper, rolbypassrls, pg_has_role($1, $2, 'MEMBER') AS in_app, pg_has_role($1, $3, 'MEMBER') AS in_owner
       FROM pg_roles WHERE rolname = $1`,
      [testDb.appRole, APP_GROUP_ROLE, OWNER_GROUP_ROLE],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, in_app: true, in_owner: false });
    const current = await sql<{ user: string }>`SELECT current_user AS user`.execute(testDb.app.db);
    expect(current.rows[0]?.user).toBe(testDb.appRole);
  });

  it("gives the group roles no superuser or BYPASSRLS", async () => {
    const { rows } = await admin.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname",
      [[APP_GROUP_ROLE, OWNER_GROUP_ROLE]],
    );
    expect(rows).toEqual([
      { rolname: APP_GROUP_ROLE, rolsuper: false, rolbypassrls: false, rolcanlogin: false },
      { rolname: OWNER_GROUP_ROLE, rolsuper: false, rolbypassrls: false, rolcanlogin: false },
    ]);
  });
});

describe.each(CAFE_TABLES)("isolation of $table", ({ table, key }) => {
  it("shows café A only its own rows", async () => {
    const counts = await withCafe(testDb.app.db, cafeA, async (trx) => {
      const own = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE ${sql.ref(key)} = ${cafeA}`.execute(trx);
      const other = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE ${sql.ref(key)} <> ${cafeA}`.execute(trx);
      return { own: own.rows[0]?.n, other: other.rows[0]?.n };
    });
    expect(counts.own).toBeGreaterThan(0);
    expect(counts.other).toBe(0);
  });

  it("shows nothing when no café is set", async () => {
    const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(testDb.app.db);
    expect(result.rows[0]?.n).toBe(0);
  });

  it("refuses to write a row for another café", async () => {
    const code = await errorCodeOf(
      withCafe(testDb.app.db, cafeA, async (trx) => {
        if (table === "cafes") {
          await trx.insertInto("cafes").values({ id: randomUUID(), name: "Intruder" }).execute();
        } else {
          await FIXTURES[table](trx, cafeB);
        }
      }),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it("cannot update or delete another café's rows", async () => {
    const privileges = await admin.query<{ can_update: boolean; can_delete: boolean }>(
      "SELECT has_table_privilege($1, $2, 'UPDATE') AS can_update, has_table_privilege($1, $2, 'DELETE') AS can_delete",
      [testDb.appRole, `app.${table}`],
    );
    const { can_update: canUpdate, can_delete: canDelete } = privileges.rows[0] ?? { can_update: false, can_delete: false };
    const affected = await withCafe(testDb.app.db, cafeA, async (trx) => {
      const updated = canUpdate
        ? (await sql`UPDATE ${sql.table(table)} SET ${sql.ref(key)} = ${sql.ref(key)} WHERE ${sql.ref(key)} = ${cafeB}`.execute(trx)).numAffectedRows
        : 0n;
      const deleted = canDelete
        ? (await sql`DELETE FROM ${sql.table(table)} WHERE ${sql.ref(key)} = ${cafeB}`.execute(trx)).numAffectedRows
        : 0n;
      return { updated, deleted };
    });
    expect(affected).toEqual({ updated: 0n, deleted: 0n });
    const remaining = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table} WHERE ${key} = $1`, [cafeB]);
    expect(remaining.rows[0]?.n).toBeGreaterThan(0);
  });
});

describe("audit log", () => {
  it("does not let the app set the id or the time of an entry", async () => {
    const backdated = await errorCodeOf(
      withCafe(testDb.app.db, cafeA, (trx) =>
        sql`INSERT INTO audit_log (cafe_id, actor_type, action, entity_type, occurred_at) VALUES (${cafeA}, 'system', 'x', 'x', '2000-01-01')`.execute(trx),
      ),
    );
    const forgedId = await errorCodeOf(
      withCafe(testDb.app.db, cafeA, (trx) =>
        sql`INSERT INTO audit_log (id, cafe_id, actor_type, action, entity_type) OVERRIDING SYSTEM VALUE VALUES (1, ${cafeA}, 'system', 'x', 'x')`.execute(trx),
      ),
    );
    expect(backdated).toBe(PERMISSION_DENIED);
    expect(forgedId).toBe(PERMISSION_DENIED);
  });

  it("is append-only for the app role", async () => {
    const update = await errorCodeOf(
      withCafe(testDb.app.db, cafeA, (trx) => sql`UPDATE audit_log SET action = 'tampered'`.execute(trx)),
    );
    const remove = await errorCodeOf(withCafe(testDb.app.db, cafeA, (trx) => sql`DELETE FROM audit_log`.execute(trx)));
    expect(update).toBe(PERMISSION_DENIED);
    expect(remove).toBe(PERMISSION_DENIED);
  });
});

describe("withCafe", () => {
  it("rejects a café id that is not a UUID before touching the database", async () => {
    await expect(withCafe(testDb.app.db, "not-a-uuid", () => Promise.resolve(1))).rejects.toThrow(TenantContextError);
  });

  it("keeps the café setting inside its transaction, on the same pooled connection", async () => {
    // One connection, so the follow-up query is guaranteed to run where the setting was made.
    const single = createDatabase({
      connectionString: testDb.appUrl,
      applicationName: "cafe-loyalty-test-single",
      maxConnections: 1,
      connectionTimeoutMs: 10_000,
      statementTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 10_000,
      idleTimeoutMs: 1_000,
      onPoolError: (error) => {
        throw error;
      },
    });
    try {
      const inside = await withCafe(single.db, cafeA, async (trx) => {
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
        const rows = await trx.selectFrom("cafes").select("id").execute();
        return { pid: pid.rows[0]?.pid, rows: rows.length };
      });
      const after = await sql<{ pid: number; value: string | null; visible: number }>`
        SELECT pg_backend_pid() AS pid, nullif(current_setting('app.cafe_id', true), '') AS value,
               (SELECT count(*)::int FROM cafes) AS visible`.execute(single.db);
      expect(inside.rows).toBe(1);
      expect(after.rows[0]).toEqual({ pid: inside.pid, value: null, visible: 0 });
    } finally {
      await single.close();
    }
  });

  it("shows nothing when the setting is empty and fails when it is not a UUID", async () => {
    const empty = await testDb.app.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.cafe_id', '', true)`.execute(trx);
      return sql<{ n: number }>`SELECT count(*)::int AS n FROM cafes`.execute(trx);
    });
    expect(empty.rows[0]?.n).toBe(0);
    const invalid = await errorCodeOf(
      testDb.app.db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.cafe_id', 'not-a-uuid', true)`.execute(trx);
        return sql`SELECT count(*) FROM cafes`.execute(trx);
      }),
    );
    expect(invalid).toBe(INVALID_TEXT_REPRESENTATION);
  });

  it("keeps updated_at current through the trigger", async () => {
    const [before, after] = await withCafe(testDb.app.db, cafeA, async (trx) => {
      const first = await trx.selectFrom("order_types").select(["id", "updated_at"]).executeTakeFirstOrThrow();
      await sql`SELECT pg_sleep(0.01)`.execute(trx);
      await trx.updateTable("order_types").set({ price_cents: 275 }).where("id", "=", first.id).execute();
      const second = await trx.selectFrom("order_types").select("updated_at").where("id", "=", first.id).executeTakeFirstOrThrow();
      return [first.updated_at, second.updated_at];
    });
    // now() is the transaction start, so the trigger value equals it; it must at least be set and not move backwards.
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
