/** Owns every schema object. No login; migrations run as a login role that is a member and switches to it. */
export const OWNER_GROUP_ROLE = "cl_owner";
/** Holds the runtime privileges. No login, no BYPASSRLS; the API and worker log in as members of it (AC 2). */
export const APP_GROUP_ROLE = "cl_app";

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Throws unless `name` is a plain lowercase PostgreSQL identifier, so it can be used in DDL safely. */
export function assertRoleOrDatabaseName(name: string, label: string): void {
  if (!ROLE_NAME.test(name)) {
    throw new Error(`${label} must be 1-63 characters of lowercase letters, digits and underscores, starting with a letter or underscore.`);
  }
}
