import type { AuditActorType, Database } from "@cafe-loyalty/db";
import { sql, type Transaction } from "kysely";

/** The database's clock, so every expiry compares against one time source. */
export const now = () => sql<Date>`now()`;
export const secondsFromNow = (seconds: number) => sql<Date>`now() + make_interval(secs => ${seconds})`;
export const secondsAgo = (seconds: number) => sql<Date>`now() - make_interval(secs => ${seconds})`;

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const { code, constraint: violated } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && violated === constraint;
}

export interface AuditEntry {
  cafeId: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** What changed, without personal data (no names, emails, phone numbers, PINs or tokens). */
  changes?: Record<string, unknown>;
}

/** Appends an entry to the café's audit log (AC 1) inside the transaction that makes the change. */
export async function audit(trx: Transaction<Database>, entry: AuditEntry): Promise<void> {
  await trx
    .insertInto("audit_log")
    .values({
      cafe_id: entry.cafeId,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      changes: JSON.stringify(entry.changes ?? {}),
    })
    .execute();
}
