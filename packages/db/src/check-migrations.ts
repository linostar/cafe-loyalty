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
      let end = index + 1;
      while (end < sql.length) {
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

const DROP_TABLE = /\bDROP\s+TABLE\b/i;
const RENAME = /\bRENAME\b/i;
/** ALTER TABLE ... DROP [COLUMN] x, but not DROP CONSTRAINT / DEFAULT / NOT NULL / IDENTITY / EXPRESSION. */
const DROP_COLUMN = /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)/i;

/** Statements that drop or rename a table or column, which break the previous release (AC 47). */
export function findBreakingStatements(sql: string): string[] {
  return stripSqlNoise(sql)
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => DROP_TABLE.test(statement) || RENAME.test(statement) || DROP_COLUMN.test(statement));
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
 * Static checks for the migration set: expand migrations never drop or rename tables or columns; a contract
 * migration names a release commit that is in this history; applied migrations are never edited. The deploy
 * script separately refuses a contract migration unless the deployed release is at or after that commit.
 */
export function checkMigrations(migrations: readonly MigrationFile[], context: MigrationCheckContext): MigrationProblem[] {
  const problems: MigrationProblem[] = [];
  for (const migration of migrations) {
    if (migration.kind === "expand") {
      for (const statement of findBreakingStatements(migration.sql)) {
        problems.push({
          fileName: migration.fileName,
          problem: `drops or renames a table or column, which only a contract migration may do: ${statement.slice(0, 160)}`,
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
