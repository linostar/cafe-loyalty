import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TABLE_COLUMNS } from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("TABLE_COLUMNS", () => {
  it("matches the columns of every table in the migrated schema", async () => {
    const client = new pg.Client({ connectionString: testDb.adminUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ table_name: string; column_name: string }>(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'app' ORDER BY table_name, ordinal_position",
      );
      const live: Record<string, string[]> = {};
      for (const row of rows) {
        (live[row.table_name] ??= []).push(row.column_name);
      }
      const expected = Object.fromEntries(Object.entries(TABLE_COLUMNS).map(([table, columns]) => [table, [...columns].sort()]));
      const actual = Object.fromEntries(Object.entries(live).map(([table, columns]) => [table, [...columns].sort()]));
      expect(actual).toEqual(expected);
    } finally {
      await client.end();
    }
  });
});
