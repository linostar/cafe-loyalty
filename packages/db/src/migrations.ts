import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's migration files: packages/db/migrations (resolved from src or dist). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * expand: only adds (tables, columns, indexes, policies); safe for the previous release, so a rollback needs
 * no schema change. contract: removes or renames; allowed only once the deployed release no longer uses what
 * it removes, named by `requires-deployed` (AC 47).
 */
export type MigrationKind = "expand" | "contract";

export interface MigrationFile {
  /** Four-digit sequence number, e.g. "0001". */
  version: string;
  name: string;
  fileName: string;
  kind: MigrationKind;
  /** For contract migrations: the commit of the release that stopped using what this migration removes. */
  requiresDeployed: string | null;
  sql: string;
  /** SHA-256 of the file contents; an applied migration must never change. */
  checksum: string;
}

export class MigrationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationFileError";
  }
}

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const KIND_HEADER = /^--\s*migration:\s*(expand|contract)\s*$/;
const REQUIRES_HEADER = /^--\s*requires-deployed:\s*([0-9a-f]{40})\s*$/;

/** Parses one migration file's name and header comments. */
export function parseMigration(fileName: string, sql: string): MigrationFile {
  const nameMatch = FILE_NAME.exec(fileName);
  if (nameMatch === null) {
    throw new MigrationFileError(`${fileName}: name must be NNNN_lowercase_words.sql`);
  }
  const [, version, name] = nameMatch;
  if (version === undefined || name === undefined) {
    throw new MigrationFileError(`${fileName}: could not read the version and name`);
  }
  const header: string[] = [];
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("--")) {
      break;
    }
    header.push(trimmed);
  }
  const kinds = header.map((line) => KIND_HEADER.exec(line)?.[1]).filter((kind) => kind !== undefined);
  if (kinds.length !== 1) {
    throw new MigrationFileError(`${fileName}: the header must contain exactly one "-- migration: expand" or "-- migration: contract" line`);
  }
  const kind = kinds[0] as MigrationKind;
  const requires = header.map((line) => REQUIRES_HEADER.exec(line)?.[1]).filter((sha) => sha !== undefined);
  if (kind === "contract" && requires.length !== 1) {
    throw new MigrationFileError(`${fileName}: a contract migration needs one "-- requires-deployed: <40-character commit>" header line`);
  }
  if (kind === "expand" && requires.length > 0) {
    throw new MigrationFileError(`${fileName}: "requires-deployed" is only allowed on contract migrations`);
  }
  return {
    version,
    name,
    fileName,
    kind,
    requiresDeployed: requires[0] ?? null,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
}

/** Loads and validates every migration in `dir`, ordered, numbered 0001 upwards without gaps or duplicates. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((entry) => entry.endsWith(".sql")).sort();
  const migrations = await Promise.all(entries.map(async (entry) => parseMigration(entry, await readFile(join(dir, entry), "utf8"))));
  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (migration.version !== expected) {
      throw new MigrationFileError(`${migration.fileName}: expected version ${expected}; versions must run 0001, 0002, ... without gaps or duplicates`);
    }
  });
  return migrations;
}
