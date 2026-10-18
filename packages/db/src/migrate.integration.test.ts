import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationStateError, migrate, type MigrateOptions } from "./migrate.js";
import { loadMigrations, parseMigration, type MigrationFile } from "./migrations.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

const quiet = { info: () => undefined };
const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.cleanup()));
});

async function freshDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase({ migrate: false });
  opened.push(db);
  return db;
}

async function runMigrations(db: TestDatabase, migrations: readonly MigrationFile[], options?: MigrateOptions) {
  const client = new pg.Client({ connectionString: db.migratorUrl });
  await client.connect();
  try {
    return await migrate(client, migrations, quiet, options);
  } finally {
    await client.end();
  }
}

async function appliedVersions(db: TestDatabase): Promise<string[]> {
  const client = new pg.Client({ connectionString: db.adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ version: string }>("SELECT version FROM meta.schema_migrations ORDER BY version");
    return rows.map((row) => row.version);
  } finally {
    await client.end();
  }
}

describe("migrate", () => {
  it("applies every migration once, then does nothing on a second run", async () => {
    const db = await freshDatabase();
    const migrations = await loadMigrations();
    const first = await runMigrations(db, migrations);
    expect(first.applied).toEqual(migrations.map((migration) => migration.version));
    const second = await runMigrations(db, migrations);
    expect(second).toEqual({ applied: [], alreadyApplied: migrations.length });
  });

  it("refuses to run when an applied migration was edited", async () => {
    const db = await freshDatabase();
    const migrations = await loadMigrations();
    await runMigrations(db, migrations);
    const [first, ...rest] = migrations;
    if (first === undefined) throw new Error("no migrations");
    const edited = parseMigration(first.fileName, `${first.sql}\n-- edited\n`);
    await expect(runMigrations(db, [edited, ...rest])).rejects.toThrow(/edited after it was applied/);
  });

  it("refuses to run an older release against a database migrated by a newer one", async () => {
    const db = await freshDatabase();
    const migrations = await loadMigrations();
    await runMigrations(db, migrations);
    await expect(runMigrations(db, migrations.slice(0, -1))).rejects.toThrow(/newer release/);
  });

  it("rolls back a failing migration completely and records nothing", async () => {
    const db = await freshDatabase();
    const migrations = await loadMigrations();
    const failing = parseMigration(
      `${String(migrations.length + 1).padStart(4, "0")}_fails.sql`,
      "-- migration: expand\nCREATE TABLE half_done (id int);\nSELECT 1 / 0;\n",
    );
    const error = await runMigrations(db, [...migrations, failing]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationStateError);
    expect((error as Error).message).toContain("rolled back");
    expect(await appliedVersions(db)).toEqual(migrations.map((migration) => migration.version));
    const client = new pg.Client({ connectionString: db.adminUrl });
    await client.connect();
    const { rows } = await client.query("SELECT to_regclass('app.half_done') AS table_name");
    await client.end();
    expect(rows[0]).toEqual({ table_name: null });
  });

  it("runs a migration outside a transaction statement by statement, and records it only once all of them ran", async () => {
    const db = await freshDatabase();
    const migrations = await loadMigrations();
    const version = String(migrations.length + 1).padStart(4, "0");
    const index = (where: string) =>
      parseMigration(
        `${version}_index_visits.sql`,
        `-- migration: expand\n-- transaction: none\nDROP INDEX CONCURRENTLY IF EXISTS visits_test_idx;\nCREATE INDEX CONCURRENTLY visits_test_idx ON visits (cafe_id) WHERE ${where};\n`,
      );
    // A failing build (no such column) is not rolled back, and nothing is recorded...
    const error = await runMigrations(db, [...migrations, index("no_such_column > 0")]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationStateError);
    expect((error as Error).message).toContain("safe to run again");
    expect(await appliedVersions(db)).toEqual(migrations.map((migration) => migration.version));
    // ...and the fixed file runs again from the start.
    expect((await runMigrations(db, [...migrations, index("stamps_added > 0")])).applied).toEqual([version]);
    const client = new pg.Client({ connectionString: db.adminUrl });
    await client.connect();
    const { rows } = await client.query<{ valid: boolean }>("SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'app.visits_test_idx'::regclass");
    await client.end();
    expect(rows).toEqual([{ valid: true }]);
  });

  it("serialises concurrent runs so each migration is applied exactly once", async () => {
    const db = await freshDatabase();
    const migrations = await loadMigrations();
    const outcomes = await Promise.all([runMigrations(db, migrations), runMigrations(db, migrations)]);
    expect(outcomes.flatMap((outcome) => outcome.applied).sort()).toEqual(migrations.map((migration) => migration.version));
    expect(await appliedVersions(db)).toEqual(migrations.map((migration) => migration.version));
  });
});

describe("migrate in expand-only mode (deploys, AC 47)", () => {
  const released = "a".repeat(40);
  const later = "b".repeat(40);

  async function withPending(): Promise<{ db: TestDatabase; migrations: MigrationFile[]; expand: MigrationFile; contract: MigrationFile }> {
    const db = await freshDatabase();
    const migrations = await loadMigrations();
    await runMigrations(db, migrations);
    const version = (offset: number): string => String(migrations.length + offset).padStart(4, "0");
    const expand = parseMigration(`${version(1)}_add_probe.sql`, "-- migration: expand\nCREATE TABLE gate_probe (id int, note text);\n");
    const contract = parseMigration(
      `${version(2)}_drop_probe_note.sql`,
      `-- migration: contract\n-- requires-deployed: ${released}\nALTER TABLE gate_probe DROP COLUMN note;\n`,
    );
    return { db, migrations, expand, contract };
  }

  it("applies expand migrations", async () => {
    const { db, migrations, expand } = await withPending();
    const outcome = await runMigrations(db, [...migrations, expand], { deployedCommits: new Set([later]) });
    expect(outcome.applied).toEqual([expand.version]);
  });

  it("refuses the whole run, expand migrations before it included, while the running release is before a contract migration", async () => {
    const { db, migrations, expand, contract } = await withPending();
    const error = await runMigrations(db, [...migrations, expand, contract], { deployedCommits: new Set([later]) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationStateError);
    expect((error as Error).message).toContain(`${contract.fileName} (requires-deployed ${released})`);
    expect(await appliedVersions(db)).toEqual(migrations.map((migration) => migration.version));
  });

  it("refuses every contract migration when the running release's history is empty", async () => {
    const { db, migrations, expand, contract } = await withPending();
    await expect(runMigrations(db, [...migrations, expand, contract], { deployedCommits: new Set() })).rejects.toThrow(/would break the running release/);
  });

  it("applies a contract migration once the running release is at or after its commit, and records that commit", async () => {
    const { db, migrations, expand, contract } = await withPending();
    const outcome = await runMigrations(db, [...migrations, expand, contract], { deployedCommits: new Set([later, released]) });
    expect(outcome.applied).toEqual([expand.version, contract.version]);
    const client = new pg.Client({ connectionString: db.adminUrl });
    await client.connect();
    const { rows } = await client.query("SELECT version, requires_deployed FROM meta.schema_migrations WHERE version >= $1 ORDER BY version", [expand.version]);
    await client.end();
    expect(rows).toEqual([
      { version: expand.version, requires_deployed: null },
      { version: contract.version, requires_deployed: released },
    ]);
  });
});
