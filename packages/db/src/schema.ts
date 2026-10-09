import type { ColumnType, Generated } from "kysely";

/** A timestamptz column the database fills in. */
type CreatedAt = ColumnType<Date, never, never>;
/** A timestamptz column a trigger keeps current. */
type UpdatedAt = ColumnType<Date, never, never>;

export interface CafesTable {
  id: ColumnType<string, string | undefined, never>;
  name: string;
  time_zone: Generated<string>;
  catalog_version: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface LoyaltyProgramsTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  stamps_required: number;
  reward_name_ar: string;
  reward_name_en: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface OrderTypesTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  name_ar: string;
  name_en: string;
  price_cents: number;
  cost_cents: number;
  stamps_earned: Generated<number>;
  active: Generated<boolean>;
  sort_order: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type AuditActorType = "owner" | "staff" | "device" | "system";

/** Append-only: the app role may insert and read, never update or delete. `changes` must hold no personal data. */
export interface AuditLogTable {
  id: ColumnType<string, never, never>;
  cafe_id: ColumnType<string, string, never>;
  actor_type: ColumnType<AuditActorType, AuditActorType, never>;
  actor_id: ColumnType<string | null, string | null | undefined, never>;
  action: ColumnType<string, string, never>;
  entity_type: ColumnType<string, string, never>;
  entity_id: ColumnType<string | null, string | null | undefined, never>;
  changes: ColumnType<Record<string, unknown>, string | undefined, never>;
  occurred_at: CreatedAt;
}

/** A token column: the SHA-256 hash of a secret the client holds (32 bytes). */
type TokenHash = ColumnType<Buffer, Buffer, never>;

export interface OwnersTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  /** Lower-case; unique across every café. */
  email: ColumnType<string, string, never>;
  password_hash: string;
  password_changed_at: ColumnType<Date, Date | undefined, Date>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface OwnerInvitesTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  token_hash: TokenHash;
  expires_at: ColumnType<Date, Date, never>;
  used_at: ColumnType<Date | null, never, Date>;
  created_at: CreatedAt;
}

export interface OwnerSessionsTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  owner_id: ColumnType<string, string, never>;
  token_hash: TokenHash;
  created_at: CreatedAt;
  last_seen_at: ColumnType<Date, never, Date>;
  expires_at: ColumnType<Date, Date, never>;
}

export interface PasswordResetTokensTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  owner_id: ColumnType<string, string, never>;
  token_hash: TokenHash;
  expires_at: ColumnType<Date, Date, never>;
  created_at: CreatedAt;
}

export interface StaffTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  name: string;
  /** PBKDF2-SHA256 of the PIN: 16-byte salt, 32-byte hash. */
  pin_salt: ColumnType<Buffer, Buffer, Buffer>;
  pin_hash: ColumnType<Buffer, Buffer, Buffer>;
  pin_iterations: number;
  revoked_at: ColumnType<Date | null, never, Date>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface DevicesTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  name: ColumnType<string, string, never>;
  paired_at: CreatedAt;
  last_renewed_at: ColumnType<Date, never, Date>;
  last_renewal_issued_at: ColumnType<Date | null, never, Date>;
  last_seen_at: ColumnType<Date, never, Date>;
  revoked_at: ColumnType<Date | null, never, Date>;
  created_at: CreatedAt;
}

/** An ECDSA P-256 public key as a JWK. */
export interface DevicePublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface DeviceKeysTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  device_id: ColumnType<string, string, never>;
  public_key: ColumnType<DevicePublicKey, string, never>;
  created_at: CreatedAt;
}

export interface DeviceTokensTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  device_id: ColumnType<string, string, never>;
  token_hash: TokenHash;
  expires_at: ColumnType<Date, Date, never>;
  created_at: CreatedAt;
}

export interface PairingCodesTable {
  id: ColumnType<string, string | undefined, never>;
  cafe_id: ColumnType<string, string, never>;
  owner_id: ColumnType<string, string, never>;
  device_name: ColumnType<string, string, never>;
  lookup_hash: TokenHash;
  secret_hash: TokenHash;
  failed_attempts: ColumnType<number, never, number>;
  expires_at: ColumnType<Date, Date, never>;
  created_at: CreatedAt;
}

/**
 * Tables in schema `app`, as the app role sees them. Every one is scoped to a café by row-level security; owners,
 * invites, sessions, reset tokens, pairing codes, device tokens and device keys can also be read (never written) by
 * their email, token hash or key id (withLookup).
 */
export interface Database {
  cafes: CafesTable;
  loyalty_programs: LoyaltyProgramsTable;
  order_types: OrderTypesTable;
  audit_log: AuditLogTable;
  owners: OwnersTable;
  owner_invites: OwnerInvitesTable;
  owner_sessions: OwnerSessionsTable;
  password_reset_tokens: PasswordResetTokensTable;
  staff: StaffTable;
  devices: DevicesTable;
  device_keys: DeviceKeysTable;
  device_tokens: DeviceTokensTable;
  pairing_codes: PairingCodesTable;
}

export type TableName = keyof Database;

type ColumnLists = { readonly [T in TableName]: readonly (keyof Database[T] & string)[] };

/** Every column of every table, checked against the live schema by an integration test. */
export const TABLE_COLUMNS = {
  cafes: ["id", "name", "time_zone", "catalog_version", "created_at", "updated_at"],
  loyalty_programs: ["id", "cafe_id", "stamps_required", "reward_name_ar", "reward_name_en", "created_at", "updated_at"],
  order_types: [
    "id",
    "cafe_id",
    "name_ar",
    "name_en",
    "price_cents",
    "cost_cents",
    "stamps_earned",
    "active",
    "sort_order",
    "created_at",
    "updated_at",
  ],
  audit_log: ["id", "cafe_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "changes", "occurred_at"],
  owners: ["id", "cafe_id", "email", "password_hash", "password_changed_at", "created_at", "updated_at"],
  owner_invites: ["id", "cafe_id", "token_hash", "expires_at", "used_at", "created_at"],
  owner_sessions: ["id", "cafe_id", "owner_id", "token_hash", "created_at", "last_seen_at", "expires_at"],
  password_reset_tokens: ["id", "cafe_id", "owner_id", "token_hash", "expires_at", "created_at"],
  staff: ["id", "cafe_id", "name", "pin_salt", "pin_hash", "pin_iterations", "revoked_at", "created_at", "updated_at"],
  devices: ["id", "cafe_id", "name", "paired_at", "last_renewed_at", "last_renewal_issued_at", "last_seen_at", "revoked_at", "created_at"],
  device_keys: ["id", "cafe_id", "device_id", "public_key", "created_at"],
  device_tokens: ["id", "cafe_id", "device_id", "token_hash", "expires_at", "created_at"],
  pairing_codes: ["id", "cafe_id", "owner_id", "device_name", "lookup_hash", "secret_hash", "failed_attempts", "expires_at", "created_at"],
} as const satisfies ColumnLists;

/** The column holding each table's café: `id` for cafes itself, `cafe_id` everywhere else. */
export const TENANT_KEY: Readonly<Record<TableName, "id" | "cafe_id">> = {
  cafes: "id",
  loyalty_programs: "cafe_id",
  order_types: "cafe_id",
  audit_log: "cafe_id",
  owners: "cafe_id",
  owner_invites: "cafe_id",
  owner_sessions: "cafe_id",
  password_reset_tokens: "cafe_id",
  staff: "cafe_id",
  devices: "cafe_id",
  device_keys: "cafe_id",
  device_tokens: "cafe_id",
  pairing_codes: "cafe_id",
};

type ListedColumns = { [T in TableName]: (typeof TABLE_COLUMNS)[T][number] };
type CompletenessByTable = { [T in TableName]: [Exclude<keyof Database[T], ListedColumns[T]>] extends [never] ? true : false };
type AssertAllTrue<X extends Record<TableName, true>> = X;
/** Compile-time check that TABLE_COLUMNS lists every column of the Database interface; fails to compile otherwise. */
export type TableColumnsAreComplete = AssertAllTrue<CompletenessByTable>;
