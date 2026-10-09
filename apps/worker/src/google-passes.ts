import { googleLogoUrl, googleLoyaltyClass, googleLoyaltyObject, signCardQr, withCafe, type Database, type Keyring, type PassUpdateJob } from "@cafe-loyalty/db";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { GoogleWallet, SaveResult } from "./google-wallet.js";

/** What the worker needs to build Google objects as the server does: the issuer, the logo's site and the QR keys. */
export interface GooglePassSettings {
  issuerId: string;
  publicUrl: string;
  cardQr: Keyring;
}

/**
 * Writes a Google pass's loyalty object as the card now is (AC 12, 13): the current stamps on the current epoch's
 * object, created if the customer has not saved it yet; INACTIVE on an earlier epoch's (AC 8), only if it exists. It
 * reads inside withCafe for the job's café, so a job naming another café's pass writes nothing (AC 2). Failures throw,
 * for pg-boss to retry; the whole object is written again, so a retry never duplicates or loses a change.
 */
export async function writeGooglePass(
  db: Kysely<Database>,
  wallet: GoogleWallet,
  settings: GooglePassSettings,
  logger: Logger,
  job: PassUpdateJob,
): Promise<{ result: SaveResult | "gone" }> {
  const found = await withCafe(db, job.cafeId, async (trx) => {
    const pass = await trx
      .selectFrom("google_passes")
      .innerJoin("cards", "cards.id", "google_passes.card_id")
      .select(["google_passes.card_id", "google_passes.epoch", "cards.epoch as card_epoch", "cards.stamps"])
      .where("google_passes.id", "=", job.passId)
      .executeTakeFirst();
    if (pass === undefined) {
      return undefined;
    }
    return {
      pass,
      cafe: await trx.selectFrom("cafes").select(["id", "name"]).where("id", "=", job.cafeId).executeTakeFirstOrThrow(),
      program: await trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst(),
    };
  });
  if (found === undefined) {
    // The card was deleted since (or the job names another café's pass).
    logger.info("google pass gone");
    return { result: "gone" };
  }
  const { pass, cafe, program } = found;
  const current = pass.epoch === pass.card_epoch;
  const object = googleLoyaltyObject(settings.issuerId, {
    cafeId: job.cafeId,
    cardId: pass.card_id,
    epoch: pass.epoch,
    stamps: pass.stamps,
    program: program === undefined ? undefined : { stampsRequired: program.stamps_required, rewardNameAr: program.reward_name_ar, rewardNameEn: program.reward_name_en },
    qr: current ? signCardQr(settings, { cardId: pass.card_id, cafeId: job.cafeId, epoch: pass.epoch }) : null,
  });
  const result = await wallet.save(googleLoyaltyClass(settings.issuerId, cafe, googleLogoUrl(settings.publicUrl)), object, current);
  logger.info({ result }, "google pass written");
  return { result };
}
