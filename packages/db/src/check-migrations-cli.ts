import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { formatStartupFailure } from "@cafe-loyalty/shared";
import { checkMigrations } from "./check-migrations.js";
import { loadCheckEnv, type CheckEnv } from "./config.js";
import { MIGRATIONS_DIR, loadMigrations } from "./migrations.js";

const GIT_TIMEOUT_MS = 30_000;

let env: CheckEnv;
try {
  env = loadCheckEnv(process.env);
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "db-check-migrations")}\n`);
  process.exit(1);
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], ...(cwd === undefined ? {} : { cwd }) });
}

function isAncestor(commit: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", commit, "HEAD"]);
    return true;
  } catch (error) {
    // Exit status 1 means "not an ancestor"; anything else (unknown commit, shallow clone) is also a failure here.
    return (error as { status?: number }).status === 0;
  }
}

function changedExistingFiles(baseRef: string): string[] {
  // Run from the repository root: pathspecs are relative to the working directory, and pnpm runs this from packages/db.
  const repoRoot = git(["rev-parse", "--show-toplevel"], MIGRATIONS_DIR).trim();
  const migrationsPath = relative(repoRoot, MIGRATIONS_DIR);
  const output = git(["diff", "--name-status", "--no-renames", `${baseRef}...HEAD`, "--", migrationsPath], repoRoot);
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("A\t"))
    .map((line) => line.split("\t").slice(1).join("\t"));
}

try {
  const migrations = await loadMigrations();
  const problems = checkMigrations(migrations, {
    isAncestor,
    changedExistingFiles: env.MIGRATIONS_BASE_REF === undefined ? [] : changedExistingFiles(env.MIGRATIONS_BASE_REF),
  });
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${problem.fileName}: ${problem.problem}\n`);
    }
    process.stderr.write(`Migration check failed: ${String(problems.length)} problem(s).\n`);
    process.exit(1);
  }
  process.stdout.write(`Migration check passed: ${String(migrations.length)} migration(s).\n`);
} catch (error) {
  process.stderr.write(`Migration check could not run: ${(error as Error).message}\n`);
  process.exit(1);
}
