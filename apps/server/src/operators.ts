import { OWNER_GROUP_ROLE, setLookup, type Database } from "@cafe-loyalty/db";
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
 * `db` must be connected as the migrator: only the owner role may create operators (migration 0022), so the server's
 * app role cannot.
 */
export async function setOperatorPassword(db: Kysely<Database>, email: string): Promise<OperatorPassword> {
  const password = newToken();
  const passwordHash = await hashPassword(password);
  const row = await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE ${sql.id(OWNER_GROUP_ROLE)}`.execute(trx);
    await setLookup(trx, { operatorEmail: email });
    const operator = await trx
      .insertInto("operators")
      .values({ email, password_hash: passwordHash })
      .onConflict((conflict) => conflict.column("email").doUpdateSet({ password_hash: passwordHash, password_changed_at: sql<Date>`now()` }))
      // xmax is 0 only on a freshly inserted row.
      .returning(["id", sql<boolean>`xmax = 0`.as("created")])
      .executeTakeFirstOrThrow();
    // Sign-in compares the stored hash under a lock (admin-routes.ts), so no session made with the old password is
    // started after this; the ones that exist end here.
    await sql`SELECT set_config('app.operator_id', ${operator.id}, true)`.execute(trx);
    await trx.deleteFrom("operator_sessions").where("operator_id", "=", operator.id).execute();
    return operator;
  });
  return { operatorId: row.id, password, created: row.created };
}
