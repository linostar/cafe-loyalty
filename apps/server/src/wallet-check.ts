import { parseArgs } from "node:util";
import { withCafe, withLookup, type Database, type PgBoss } from "@cafe-loyalty/db";
import { linkTokenSchema } from "@cafe-loyalty/shared";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { hashToken, newToken } from "./credentials.js";
import { audit, now } from "./db-helpers.js";
import { queuePassUpdate } from "./pass-updates.js";

/**
 * The manual wallet check (AC 46), run against staging: makes a demo card whose web card offers the Apple and Google
 * passes, then changes it the way stamping and recovery do, so a tester sees on real phones that passes save, update
 * and void. The card is an ordinary card without a phone number; delete it from its web card afterwards.
 */
export type WalletCheckCommand = { command: "issue"; cafeId: string } | { command: "stamp" | "restore"; secret: string };

export const WALLET_CHECK_USAGE = [
  "Usage: wallet-check issue --cafe-id <uuid>    a demo card at the café; prints its web card link",
  "       wallet-check stamp <web card link>     adds a stamp (back to 0 once the reward is due); passes update",
  "       wallet-check restore <web card link>   moves the card to a new phone, as recovery does; prints the new link",
].join("\n");

/** The card secret of a web card link (`https://…/c/<secret>?lang=en`) or of the bare secret. */
const secretOf = (value: string): string | undefined => {
  const secret = /(?:^|\/c\/)([A-Za-z0-9_-]{43})(?:[?#].*)?$/.exec(value)?.[1];
  return secret !== undefined && linkTokenSchema.safeParse(secret).success ? secret : undefined;
};

export function parseWalletCheckArgs(args: readonly string[]): WalletCheckCommand | null {
  try {
    const { values, positionals } = parseArgs({ args: [...args], options: { "cafe-id": { type: "string" } }, allowPositionals: true, strict: true });
    const [command, link, ...rest] = positionals;
    if (command === "issue" && link === undefined) {
      const cafeId = z.uuid().safeParse(values["cafe-id"]);
      return cafeId.success ? { command, cafeId: cafeId.data } : null;
    }
    if ((command === "stamp" || command === "restore") && link !== undefined && rest.length === 0 && values["cafe-id"] === undefined) {
      const secret = secretOf(link);
      return secret === undefined ? null : { command, secret };
    }
  } catch {
    // Unknown option: the usage follows.
  }
  return null;
}

const cardLink = (publicUrl: string, secret: string) => new URL(`/c/${secret}`, publicUrl).toString();

/** Runs one command; returns what to print. Every change is audit-logged as the wallet check's. */
export async function runWalletCheck(db: Kysely<Database>, jobs: PgBoss | undefined, publicUrl: string, command: WalletCheckCommand): Promise<string> {
  const changes = { source: "wallet_check" };
  if (command.command === "issue") {
    const secret = newToken();
    await withCafe(db, command.cafeId, async (trx) => {
      const card = await trx
        .insertInto("cards")
        .values({ cafe_id: command.cafeId, web_secret_hash: hashToken(secret), privacy_accepted_at: now() })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, { cafeId: command.cafeId, actorType: "system", actorId: null, action: "card.created", entityType: "card", entityId: card.id, changes });
    });
    return `Demo card created. Open this link on each test phone and add the card to its wallet:\n${cardLink(publicUrl, secret)}`;
  }
  const secretHash = hashToken(command.secret);
  const card = await withLookup(db, { secretHash }, (trx) => trx.selectFrom("cards").select(["id", "cafe_id"]).where("web_secret_hash", "=", secretHash).executeTakeFirst());
  if (card === undefined) {
    throw new Error("No card has this link: it was restored or deleted since. Use the newest link.");
  }
  return withCafe(db, card.cafe_id, async (trx) => {
    if (command.command === "stamp") {
      const program = await trx.selectFrom("loyalty_programs").select("stamps_required").executeTakeFirst();
      const updated = await trx
        .updateTable("cards")
        .set({ stamps: sql<number>`CASE WHEN stamps >= ${program?.stamps_required ?? 2_147_483_646} THEN 0 ELSE stamps + 1 END` })
        .where("id", "=", card.id)
        .returning("stamps")
        .executeTakeFirstOrThrow();
      await audit(trx, { cafeId: card.cafe_id, actorType: "system", actorId: null, action: "card.stamps_set", entityType: "card", entityId: card.id, changes: { ...changes, stamps: updated.stamps } });
      await queuePassUpdate(trx, jobs, card.cafe_id, card.id);
      return `The card has ${String(updated.stamps)} stamps. Within a minute, each phone's pass should show them, without a notification.`;
    }
    const secret = newToken();
    await trx
      .updateTable("cards")
      .set({ epoch: sql<number>`epoch + 1`, web_secret_hash: hashToken(secret) })
      .where("id", "=", card.id)
      .execute();
    await audit(trx, { cafeId: card.cafe_id, actorType: "system", actorId: null, action: "card.restored", entityType: "card", entityId: card.id, changes });
    await queuePassUpdate(trx, jobs, card.cafe_id, card.id);
    return `The card moved to a new link. Within a minute, the passes added so far should show it voided (Apple) or inactive (Google). New link, for adding the card again:\n${cardLink(publicUrl, secret)}`;
  });
}
