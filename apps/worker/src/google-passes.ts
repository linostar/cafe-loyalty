import {
  feedbackUrl,
  googleLogoUrl,
  googleLoyaltyClass,
  googleLoyaltyObject,
  googleOfferMessage,
  loadCardOffer,
  loadFeedbackRequest,
  offerKey,
  signCardQr,
  withCafe,
  type Database,
  type Keyring,
  type PassUpdateJob,
} from "@cafe-loyalty/db";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";
import type { GoogleWallet, SaveResult } from "./google-wallet.js";

/** What the worker needs to build Google objects as the server does: the issuer, the site (logo, feedback links) and the QR keys. */
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
 * adds the message that notifies (AC 14), unless the card's Apple pass is on a device (Wallet tells that one itself,
 * and AC 14 counts per card). The pass records it before the write, so a retry, or a write whose answer was lost,
 * never notifies twice; a failed one does not notify at all (logged; the offer still shows).
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
      feedback: await loadFeedbackRequest(trx, pass.card_id),
      appleOnDevice:
        (await trx
          .selectFrom("apple_pass_registrations")
          .innerJoin("apple_passes", "apple_passes.id", "apple_pass_registrations.pass_id")
          .select("apple_passes.id")
          .where("apple_passes.card_id", "=", pass.card_id)
          .where("apple_passes.epoch", "=", pass.card_epoch)
          .executeTakeFirst()) !== undefined,
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
  // Only a pass that existed when the offer was announced (one saved since, on a new phone, shows it silently), and
  // only for a card whose Apple pass is not told already: the card is told once that day.
  const notify =
    offer !== undefined &&
    offer.mayNotify &&
    !found.appleOnDevice &&
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
    feedbackUrl: current && found.feedback !== undefined ? feedbackUrl(settings.publicUrl, settings, found.feedback) : undefined,
  });
  let result: SaveResult;
  try {
    result = await wallet.save(googleLoyaltyClass(settings.issuerId, cafe, googleLogoUrl(settings.publicUrl)), object, current, notify ? googleOfferMessage(offer) : undefined);
  } catch (error) {
    if (notify) {
      // Recorded as told already, so the retry writes the offer silently: unless Google applied the write and only its
      // answer was lost, this notification is not sent (AC 14 over AC 42).
      logger.warn({ offer: offerKey(offer) }, "google offer notification may not have been sent: the write failed");
    }
    throw error;
  }
  logger.info({ result, notified: notify }, "google pass written");
  return { result };
}
