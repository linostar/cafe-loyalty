import { randomUUID } from "node:crypto";
import { withCafe, type Database } from "@cafe-loyalty/db";
import { sql, type Kysely, type Transaction } from "kysely";
import { hashToken, newToken } from "./credentials.js";

/** An invite link works for this long. */
export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface OwnerInvite {
  cafeId: string;
  /** The secret for the link; only its hash is stored. */
  token: string;
  expiresAt: Date;
}

/** Who the invite is for: a new café with this name, or another owner (or a fresh link) for an existing café. */
export type InviteTarget = { newCafeName: string } | { cafeId: string };

async function insertInvite(trx: Transaction<Database>, cafeId: string): Promise<OwnerInvite> {
  const token = newToken();
  const invite = await trx
    .insertInto("owner_invites")
    .values({ cafe_id: cafeId, token_hash: hashToken(token), expires_at: sql<Date>`now() + make_interval(secs => ${INVITE_TTL_SECONDS})` })
    .returning(["id", "expires_at"])
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("audit_log")
    .values({ cafe_id: cafeId, actor_type: "system", action: "owner_invite.created", entity_type: "owner_invite", entity_id: invite.id })
    .execute();
  return { cafeId, token, expiresAt: invite.expires_at };
}

/**
 * Creates a single-use owner invite, and for a new café the café itself.
 *
 * Café creation is the one place a café id does not come from an authenticated session, device or job (plan
 * Step 5): only the operator creates cafés, through this function's command-line tool, so the id is generated
 * here and set with withCafe before the café row is inserted. An existing café's id comes from the operator.
 */
export async function createOwnerInvite(db: Kysely<Database>, target: InviteTarget): Promise<OwnerInvite> {
  const cafeId = "cafeId" in target ? target.cafeId : randomUUID();
  return withCafe(db, cafeId, async (trx) => {
    if ("newCafeName" in target) {
      await trx.insertInto("cafes").values({ id: cafeId, name: target.newCafeName }).execute();
      await trx.insertInto("audit_log").values({ cafe_id: cafeId, actor_type: "system", action: "cafe.created", entity_type: "cafe", entity_id: cafeId }).execute();
    } else if ((await trx.selectFrom("cafes").select("id").executeTakeFirst()) === undefined) {
      throw new Error("No café has this id.");
    }
    return insertInvite(trx, cafeId);
  });
}

/** The dashboard link for an invite; the token is in the fragment, which browsers never send to a server. */
export function inviteLink(dashboardUrl: string, token: string): string {
  const link = new URL("/signup", dashboardUrl);
  link.hash = `invite=${token}`;
  return link.toString();
}
