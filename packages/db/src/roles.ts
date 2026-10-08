/** Owns every schema object. No login; migrations run as a login role that is a member and switches to it. */
export const OWNER_GROUP_ROLE = "cl_owner";
/** Holds the runtime privileges. No login, no BYPASSRLS; the API and worker log in as members of it (AC 2). */
export const APP_GROUP_ROLE = "cl_app";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED = new Set([OWNER_GROUP_ROLE, APP_GROUP_ROLE, "postgres", "template0", "template1", "public"]);

/**
 * Throws unless `name` is a plain lowercase PostgreSQL identifier that is safe to create or alter: not a group
 * role, a built-in role or database, a `pg_` name, or the role running the bootstrap.
 */
export function assertRoleOrDatabaseName(name: string, label: string, adminRole?: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`${label} must be 1-63 characters of lowercase letters, digits and underscores, starting with a letter or underscore.`);
  }
  if (RESERVED.has(name) || name.startsWith("pg_") || name === adminRole) {
    throw new Error(`${label} must not be a reserved or administrative name.`);
  }
}
