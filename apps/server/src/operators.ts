import { withLookup, withOperator, type Database } from "@cafe-loyalty/db";
import { sql, type Kysely } from "kysely";
import { hashPassword, newToken } from "./credentials.js";

export interface OperatorPassword {
  operatorId: string;
  /** The new password, shown once by create-operator; only its argon2id hash is stored. */
  password: string;
  /** False when the operator already existed and got a new password. */
  created: boolean;
}

/**
 * Creates the operator with this (normalised) email, or gives an existing one a new password, and ends their sessions
 * (AC 39). The password is random (256 bits), so nobody chooses a weak one; run it again to replace a lost one.
 */
export async function setOperatorPassword(db: Kysely<Database>, email: string): Promise<OperatorPassword> {
  const password = newToken();
  const passwordHash = await hashPassword(password);
  const row = await withLookup(
    db,
    { operatorEmail: email },
    (trx) =>
      trx
        .insertInto("operators")
        .values({ email, password_hash: passwordHash })
        .onConflict((conflict) => conflict.column("email").doUpdateSet({ password_hash: passwordHash, password_changed_at: sql<Date>`now()` }))
        // xmax is 0 only on a freshly inserted row.
        .returning(["id", sql<boolean>`xmax = 0`.as("created")])
        .executeTakeFirstOrThrow(),
    "read write",
  );
  // Sign-in compares the stored hash under a lock (admin-routes.ts), so no session made with the old password is
  // started after this; the ones that exist end here.
  await withOperator(db, row.id, (trx) => trx.deleteFrom("operator_sessions").where("operator_id", "=", row.id).execute());
  return { operatorId: row.id, password, created: row.created };
}
