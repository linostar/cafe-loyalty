import { describe, expect, it } from "vitest";
import { checkMigrations, findBreakingStatements, stripSqlNoise } from "./check-migrations.js";
import { parseMigration } from "./migrations.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("findBreakingStatements", () => {
  it.each([
    "DROP TABLE visits",
    "drop table if exists visits cascade",
    'DROP TABLE "visits"',
    "ALTER TABLE visits DROP COLUMN note",
    "ALTER TABLE visits DROP note",
    "ALTER TABLE IF EXISTS visits DROP COLUMN IF EXISTS note",
    "ALTER TABLE visits RENAME TO visit_log",
    "ALTER TABLE visits RENAME COLUMN note TO comment",
    "ALTER TABLE visits ADD COLUMN x int, DROP COLUMN note",
  ])("flags %s", (statement) => {
    expect(findBreakingStatements(`${statement};`)).toHaveLength(1);
  });

  it.each([
    "CREATE TABLE visits (id uuid)",
    "ALTER TABLE visits ADD COLUMN note text",
    "ALTER TABLE visits DROP CONSTRAINT visits_note_check",
    "ALTER TABLE visits ALTER COLUMN note DROP DEFAULT",
    "ALTER TABLE visits ALTER COLUMN note DROP NOT NULL",
    "DROP POLICY IF EXISTS cafe_isolation ON visits",
    "DROP INDEX visits_note_idx",
    "-- DROP TABLE visits\nSELECT 1",
    "/* ALTER TABLE visits RENAME TO x */ SELECT 1",
    "INSERT INTO notes (body) VALUES ('please DROP TABLE visits; and RENAME things')",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE 'DROP TABLE x'; END $body$",
    "CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
  ])("allows %s", (statement) => {
    expect(findBreakingStatements(`${statement};`)).toEqual([]);
  });
});

describe("stripSqlNoise", () => {
  it("keeps statement text and handles doubled quotes", () => {
    expect(stripSqlNoise("SELECT 'it''s DROP TABLE x' AS y; -- tail").replace(/\s+/g, " ").trim()).toBe("SELECT AS y;");
  });
});

describe("checkMigrations", () => {
  const expand = parseMigration("0001_a.sql", "-- migration: expand\nCREATE TABLE a (id int);\n");
  const badExpand = parseMigration("0002_b.sql", "-- migration: expand\nALTER TABLE a DROP COLUMN id;\n");
  const contract = parseMigration("0003_c.sql", `-- migration: contract\n-- requires-deployed: ${SHA}\nDROP TABLE a;\n`);
  const inHistory = { isAncestor: (commit: string) => commit === SHA, changedExistingFiles: [] };

  it("passes additive migrations and contract migrations whose release is in history", () => {
    expect(checkMigrations([expand, contract], inHistory)).toEqual([]);
  });

  it("fails an expand migration that drops a column", () => {
    expect(checkMigrations([expand, badExpand], inHistory)).toEqual([
      { fileName: "0002_b.sql", problem: expect.stringContaining("only a contract migration may do") as unknown },
    ]);
  });

  it("fails a contract migration whose release is not in history", () => {
    const problems = checkMigrations([contract], { isAncestor: () => false, changedExistingFiles: [] });
    expect(problems).toEqual([{ fileName: "0003_c.sql", problem: expect.stringContaining(SHA) as unknown }]);
  });

  it("fails when an existing migration was edited", () => {
    const problems = checkMigrations([expand], { ...inHistory, changedExistingFiles: ["packages/db/migrations/0001_a.sql"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("add a new migration instead");
  });
});
