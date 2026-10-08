import type { MigrationFile } from "./migrations.js";

/** Removes comments, quoted strings and dollar-quoted bodies so keyword checks see only statement text. */
export function stripSqlNoise(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      output += " ";
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar !== null) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, index + tag.length);
      index = end === -1 ? sql.length : end + tag.length;
      output += " ";
      continue;
    }
    const char = sql.charAt(index);
    if (char === "'" || char === '"') {
      // E'...' strings treat a backslash as an escape, so \' does not end them.
      const escapeString = char === "'" && /(^|[^A-Za-z0-9_$])[Ee]$/.test(output);
      let end = index + 1;
      while (end < sql.length) {
        if (escapeString && sql.charAt(end) === "\\") {
          end += 2;
          continue;
        }
        if (sql.charAt(end) === char) {
          if (sql.charAt(end + 1) === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      // Quoted identifiers stay as a placeholder word so "DROP TABLE "x"" is still seen as a drop.
      output += char === '"' ? " ident " : " ";
      index = end + 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/** Drops that remove tables or columns directly or through CASCADE (a type or schema drop takes its columns with it). */
const DROP_OBJECT = /\bDROP\s+(TABLE|SCHEMA|TYPE|DOMAIN|VIEW|MATERIALIZED\s+VIEW|EXTENSION)\b/i;
const RENAME = /\bRENAME\b/i;
/** Moving a table to another schema renames it for every query that uses it. */
const SET_SCHEMA = /\bSET\s+SCHEMA\b/i;
/** A DO block's body is code the check cannot see into, so it may hide a drop. */
const DO_BLOCK = /^DO\b/i;
/** ALTER TABLE ... DROP [COLUMN] x, but not DROP CONSTRAINT / DEFAULT / NOT NULL / IDENTITY / EXPRESSION. */
const DROP_COLUMN = /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)/i;

/** Statements that drop or rename a table or column (or might, like a DO block), which break the previous release (AC 47). */
export function findBreakingStatements(sql: string): string[] {
  return stripSqlNoise(sql)
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0)
    .filter(
      (statement) =>
        DROP_OBJECT.test(statement) || RENAME.test(statement) || SET_SCHEMA.test(statement) || DROP_COLUMN.test(statement) || DO_BLOCK.test(statement),
    );
}

/**
 * Statements the runner owns: transaction control and changes of role, session or search path. A migration that
 * runs one of these could commit half its work or create objects owned by the wrong role.
 */
const FORBIDDEN = /\b(BEGIN|COMMIT|ROLLBACK|ABORT|END|SAVEPOINT|RELEASE|START\s+TRANSACTION|SET\s+(SESSION\s+|LOCAL\s+)?(ROLE|SESSION\s+AUTHORIZATION|SEARCH_PATH)|RESET\s+(ROLE|ALL|SESSION\s+AUTHORIZATION|SEARCH_PATH))\b/i;

/** Statements that control transactions or change role or search path, which only the runner may do. */
export function findForbiddenStatements(sql: string): string[] {
  return stripSqlNoise(sql)
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => FORBIDDEN.test(statement));
}

export interface MigrationProblem {
  fileName: string;
  problem: string;
}

export interface MigrationCheckContext {
  /** Whether a commit is in the history of the commit being checked. */
  isAncestor(commit: string): boolean;
  /** Existing migration files changed, deleted or renamed relative to the base branch (empty when not checking against one). */
  changedExistingFiles: readonly string[];
}

/**
 * Static checks for the migration set: no migration controls transactions or changes role; expand migrations never
 * drop or rename tables or columns; a contract migration names a release commit that is in this history; applied
 * migrations are never edited. Checking that the deployed release is at or after that commit is the deploy
 * script's job (plan Step 19).
 */
export function checkMigrations(migrations: readonly MigrationFile[], context: MigrationCheckContext): MigrationProblem[] {
  const problems: MigrationProblem[] = [];
  for (const migration of migrations) {
    for (const statement of findForbiddenStatements(migration.sql)) {
      problems.push({
        fileName: migration.fileName,
        problem: `controls transactions or changes the role or search path, which only the migration runner may do: ${statement.slice(0, 160)}`,
      });
    }
    if (migration.kind === "expand") {
      for (const statement of findBreakingStatements(migration.sql)) {
        problems.push({
          fileName: migration.fileName,
          problem: `drops or renames a table or column (or runs a DO block), which only a contract migration may do: ${statement.slice(0, 160)}`,
        });
      }
    } else if (migration.requiresDeployed === null || !context.isAncestor(migration.requiresDeployed)) {
      problems.push({
        fileName: migration.fileName,
        problem: `requires-deployed ${migration.requiresDeployed ?? "(missing)"} is not a commit in this branch's history`,
      });
    }
  }
  for (const fileName of context.changedExistingFiles) {
    problems.push({ fileName, problem: "an existing migration was edited, renamed or deleted; add a new migration instead" });
  }
  return problems;
}
