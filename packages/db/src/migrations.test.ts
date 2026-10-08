import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationFileError, loadMigrations, parseMigration } from "./migrations.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("parseMigration", () => {
  it("reads version, name, kind and a stable checksum", () => {
    const sql = "-- migration: expand\n-- Adds things.\nCREATE TABLE t (id int);\n";
    const migration = parseMigration("0003_add_things.sql", sql);
    expect(migration).toMatchObject({ version: "0003", name: "add_things", kind: "expand", requiresDeployed: null });
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(parseMigration("0003_add_things.sql", sql).checksum).toBe(migration.checksum);
    expect(parseMigration("0003_add_things.sql", `${sql} `).checksum).not.toBe(migration.checksum);
  });

  it("reads the release a contract migration depends on", () => {
    const migration = parseMigration("0004_drop_old.sql", `-- migration: contract\n-- requires-deployed: ${SHA}\nDROP TABLE old;\n`);
    expect(migration).toMatchObject({ kind: "contract", requiresDeployed: SHA });
  });

  it.each([
    ["a bad file name", "4_x.sql", "-- migration: expand\n"],
    ["upper case in the name", "0004_Add.sql", "-- migration: expand\n"],
    ["no kind header", "0004_x.sql", "-- just a comment\nSELECT 1;\n"],
    ["the kind after the first statement", "0004_x.sql", "SELECT 1;\n-- migration: expand\n"],
    ["two kind headers", "0004_x.sql", "-- migration: expand\n-- migration: contract\n"],
    ["a contract migration without requires-deployed", "0004_x.sql", "-- migration: contract\nDROP TABLE t;\n"],
    ["requires-deployed on an expand migration", "0004_x.sql", `-- migration: expand\n-- requires-deployed: ${SHA}\n`],
    ["a short commit", "0004_x.sql", "-- migration: contract\n-- requires-deployed: abc123\n"],
  ])("rejects %s", (_label, fileName, sql) => {
    expect(() => parseMigration(fileName, sql)).toThrow(MigrationFileError);
  });
});

describe("loadMigrations", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function directoryWith(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "cl-migrations-"));
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(join(dir, name), sql);
    }
    return dir;
  }

  it("loads files in order and ignores non-SQL files", async () => {
    const path = await directoryWith({
      "0002_b.sql": "-- migration: expand\nSELECT 2;\n",
      "0001_a.sql": "-- migration: expand\nSELECT 1;\n",
      "README.md": "notes",
    });
    expect((await loadMigrations(path)).map((migration) => migration.version)).toEqual(["0001", "0002"]);
  });

  it("rejects a gap in the numbering", async () => {
    const path = await directoryWith({ "0001_a.sql": "-- migration: expand\n", "0003_c.sql": "-- migration: expand\n" });
    await expect(loadMigrations(path)).rejects.toThrow(/expected version 0002/);
  });

  it("rejects a duplicate version", async () => {
    const path = await directoryWith({ "0001_a.sql": "-- migration: expand\n", "0001_b.sql": "-- migration: expand\n" });
    await expect(loadMigrations(path)).rejects.toThrow(MigrationFileError);
  });
});
