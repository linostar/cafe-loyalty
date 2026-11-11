import { PASS_BACKGROUND, googleLoyaltyClass, googleLoyaltyObject, signJwt, type CafeBranding, type GoogleLoyaltyObject, type GooglePassContent, type GoogleWalletConfig } from "@cafe-loyalty/db";
import { readFileSync } from "node:fs";
import { solidPng } from "./apple-pass.js";
import type { Lang } from "./customer-html.js";

/** The class logo (googleLogoUrl): Google's recommended 660 px square. */
export const GOOGLE_LOGO_PNG = solidPng(660, PASS_BACKGROUND);

/** What saving needs of an object: its ids, state, QR and the picture of its stamps (without its description). */
function saveLinkObject(object: GoogleLoyaltyObject) {
  if (object.state === "INACTIVE") {
    return { id: object.id, classId: object.classId, state: object.state };
  }
  return {
    id: object.id,
    classId: object.classId,
    state: object.state,
    barcode: object.barcode,
    ...("heroImage" in object ? { heroImage: { sourceUri: object.heroImage.sourceUri } } : {}),
  };
}

/**
 * A card's "Add to Google Wallet" link (AC 10): a JWT signed by the service account, carrying the café's class and the
 * card's object as they are now. Saving creates whichever does not exist yet and keeps one that does (the worker
 * wrote it first); the worker keeps the object current from then on (AC 12, 13). The object goes without its labels
 * and texts, which the write queued with the link adds seconds later (or the worker's sweep, without a job queue):
 * Google advises save links under about 1,800 characters, and the whole bilingual object is nearly twice that.
 */
export function googleSaveUrl(config: GoogleWalletConfig, publicUrl: string, cafe: CafeBranding, content: GooglePassContent): string {
  const jwt = signJwt(
    {
      iss: config.serviceAccount.email,
      aud: "google",
      typ: "savetowallet",
      iat: Math.floor(Date.now() / 1000),
      // A link, not Google's JavaScript button, so no page origins.
      origins: [],
      payload: {
        // Without the review link (up to 500 characters), for the link's length: Google keeps a class that exists
        // (written whole by the worker), and one this link creates is completed by the queued write, as the café has
        // no google_class_hash until the worker's own class write records one.
        loyaltyClasses: [googleLoyaltyClass(config.issuerId, { ...cafe, reviewUrl: null }, publicUrl)],
        loyaltyObjects: [saveLinkObject(googleLoyaltyObject(config.issuerId, content, publicUrl))],
      },
    },
    config.serviceAccount.privateKey,
  );
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

/**
 * Google's own "Add to Google Wallet" badge in the page's language, as a data URI (the web card's CSP allows no other
 * images). The brand guidelines allow only Google's badges, unaltered: apps/server/assets/google-wallet.
 */
export const GOOGLE_WALLET_BADGES: Readonly<Record<Lang, string>> = Object.fromEntries(
  (["ar", "en"] as const).map((lang) => [
    lang,
    `data:image/svg+xml;base64,${readFileSync(new URL(`../assets/google-wallet/add-to-google-wallet-${lang}.svg`, import.meta.url)).toString("base64")}`,
  ]),
) as Record<Lang, string>;
