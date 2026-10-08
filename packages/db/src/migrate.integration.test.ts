import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationStateError, migrate } from "./migrate.js";
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

async function runMigrations(db: TestDatabase, migrations: readonly MigrationFile[]) {
  const client = new pg.Client({ connectionString: db.migratorUrl });
  await client.connect();
  try {
    return await migrate(client, migrations, quiet);
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

  it("serialises concurrent runs so each migration is applied exactly once", async () => {
    const db = await freshDatabase();
    const migrations = await loadMigrations();
    const outcomes = await Promise.all([runMigrations(db, migrations), runMigrations(db, migrations)]);
    expect(outcomes.flatMap((outcome) => outcome.applied).sort()).toEqual(migrations.map((migration) => migration.version));
    expect(await appliedVersions(db)).toEqual(migrations.map((migration) => migration.version));
  });
});
