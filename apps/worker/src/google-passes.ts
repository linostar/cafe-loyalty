import {
  googleLogoUrl,
  googleLoyaltyClass,
  googleLoyaltyObject,
  googleOfferMessage,
  loadCardOffer,
  signCardQr,
  withCafe,
  type Database,
  type Keyring,
  type PassUpdateJob,
} from "@cafe-loyalty/db";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";
import type { GoogleWallet, SaveResult } from "./google-wallet.js";

/** What the worker needs to build Google objects as the server does: the issuer, the logo's site and the QR keys. */
export interface GooglePassSettings {
  issuerId: string;
  publicUrl: string;
  cardQr: Keyring;
}

/**
 * Writes a Google pass's loyalty object as the card now is (AC 12, 13): the current stamps and offer on the current
 * epoch's object, created if the customer has not saved it yet; INACTIVE on an earlier epoch's (AC 8), only if it
 * exists. It reads inside withCafe for the job's café, so a job naming another café's pass writes nothing (AC 2).
 * Failures throw, for pg-boss to retry; the whole object is written again, so a retry never duplicates or loses a
 * change. The first write after an offer's announcement, on the day it was announced, to a pass that existed by then,
 * adds the message that notifies (AC 14); the pass records that before the write, so a retry, or a write whose answer was lost, never notifies twice
 * (a failed one does not notify at all; the offer still shows).
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
      .select(["google_passes.card_id", "google_passes.epoch", "google_passes.offer_notified_at", "google_passes.created_at", "cards.epoch as card_epoch", "cards.stamps"])
      .where("google_passes.id", "=", job.passId)
      .executeTakeFirst();
    if (pass === undefined) {
      return undefined;
    }
    return {
      pass,
      cafe: await trx.selectFrom("cafes").select(["id", "name"]).where("id", "=", job.cafeId).executeTakeFirstOrThrow(),
      program: await trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst(),
      offers: await loadCardOffer(trx, pass.card_id),
    };
  });
  if (found === undefined) {
    // The card was deleted since (or the job names another café's pass).
    logger.info("google pass gone");
    return { result: "gone" };
  }
  const { pass, cafe, program } = found;
  const current = pass.epoch === pass.card_epoch;
  const offer = current ? found.offers.offer : undefined;
  // Only a pass that existed when the offer was announced: one saved since (on a new phone, or after the card's Apple
  // pass was told) shows the offer silently, so the card is not told twice that day.
  const notify =
    offer !== undefined &&
    offer.mayNotify &&
    pass.created_at < offer.announcedAt &&
    (pass.offer_notified_at === null || pass.offer_notified_at < offer.announcedAt);
  if (notify) {
    await withCafe(db, job.cafeId, (trx) => trx.updateTable("google_passes").set({ offer_notified_at: sql<Date>`now()` }).where("id", "=", job.passId).execute());
  }
  const object = googleLoyaltyObject(settings.issuerId, {
    cafeId: job.cafeId,
    cardId: pass.card_id,
    epoch: pass.epoch,
    stamps: pass.stamps,
    program: program === undefined ? undefined : { stampsRequired: program.stamps_required, rewardNameAr: program.reward_name_ar, rewardNameEn: program.reward_name_en },
    qr: current ? signCardQr(settings, { cardId: pass.card_id, cafeId: job.cafeId, epoch: pass.epoch }) : null,
    offer,
  });
  const result = await wallet.save(googleLoyaltyClass(settings.issuerId, cafe, googleLogoUrl(settings.publicUrl)), object, current, notify ? googleOfferMessage(offer) : undefined);
  logger.info({ result, notified: notify }, "google pass written");
  return { result };
}
