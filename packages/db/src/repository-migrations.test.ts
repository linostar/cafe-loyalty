import { describe, expect, it } from "vitest";
import { checkMigrations } from "./check-migrations.js";
import { loadMigrations } from "./migrations.js";

describe("the repository's migrations", () => {
  it("load, are numbered without gaps, and pass the static check", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    // Contract migrations are checked against git history by the CLI; here none may exist without one.
    const problems = checkMigrations(migrations, { isAncestor: () => false, changedExistingFiles: [] });
    expect(problems.filter((problem) => !problem.problem.startsWith("requires-deployed"))).toEqual([]);
  });
});
