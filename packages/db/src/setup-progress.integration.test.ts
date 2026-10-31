import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import { loadMigrations } from "./migrations.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

const quiet = { info: () => undefined };
const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.cleanup()));
});

async function migrateAs(db: TestDatabase, migrations: Awaited<ReturnType<typeof loadMigrations>>) {
  const client = new pg.Client({ connectionString: db.migratorUrl });
  await client.connect();
  try {
    await migrate(client, migrations, quiet);
  } finally {
    await client.end();
  }
}

it("takes only cafés without a loyalty program through the setup wizard, leaving no backfill policy behind (D1)", async () => {
  const db = await createTestDatabase({ migrate: false });
  opened.push(db);
  const migrations = await loadMigrations();
  const index = migrations.findIndex((migration) => migration.fileName === "0023_cafe_setup_progress.sql");
  expect(index).toBeGreaterThan(0);
  await migrateAs(db, migrations.slice(0, index));

  const admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  try {
    const { rows: cafes } = await admin.query<{ id: string; name: string }>("INSERT INTO app.cafes (name) VALUES ('Set up'), ('New') RETURNING id, name");
    const setUp = cafes.find((cafe) => cafe.name === "Set up")?.id;
    await admin.query("INSERT INTO app.loyalty_programs (cafe_id, stamps_required, reward_name_ar, reward_name_en) VALUES ($1, 9, 'قهوة', 'Coffee')", [setUp]);

    await migrateAs(db, migrations);

    const { rows } = await admin.query<{ name: string; finished: boolean; printed: boolean }>(
      "SELECT name, setup_finished_at IS NOT NULL AS finished, signup_qr_printed_at IS NOT NULL AS printed FROM app.cafes ORDER BY name",
    );
    expect(rows).toEqual([
      { name: "New", finished: false, printed: false },
      { name: "Set up", finished: true, printed: false },
    ]);
    const { rows: policies } = await admin.query("SELECT policyname FROM pg_policies WHERE policyname LIKE 'setup_backfill%'");
    expect(policies).toEqual([]);
  } finally {
    await admin.end();
  }
});
