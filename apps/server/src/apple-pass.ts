import { createHmac } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { PASS_BACKGROUND, offerText, type CardOffer } from "@cafe-loyalty/db";
import { PKPass } from "passkit-generator";
import type { CustomerSecrets } from "./customer-crypto.js";
import { count, t, type Lang } from "./customer-html.js";

/** Apple Wallet settings (APPLE_* variables): the pass type and team ids and the certificates that sign passes. */
export interface ApplePassConfig {
  passTypeId: string;
  teamId: string;
  /** PEM: the pass type certificate and its key, and Apple's WWDR intermediate certificate. */
  certificates: { signerCert: string; signerKey: string; wwdr: string };
}

/**
 * The pass layout this release builds, stored per pass (AC 12). A pass on another layout counts as changed when next
 * fetched, so every device of it gets the new layout; bump this when the layout changes (and, to reach passes nobody
 * fetches, push those whose layout_version is older).
 */
export const APPLE_PASS_LAYOUT_VERSION = 2;

/**
 * The authenticationToken of a card's pass at the epoch of `webSecret` (AC 11): 256 bits keyed with the pepper from
 * the web card's random secret, so a second download from the web card gives the same pass rather than locking the
 * first one out, and recovery (a new web secret) gives the new phone's pass a new token. Stored only as its SHA-256.
 */
export const applePassToken = (secrets: CustomerSecrets, webSecret: string): string =>
  createHmac("sha256", secrets.phoneLookupPepper).update("apple-pass:").update(webSecret).digest("base64url");

export interface ApplePassContent {
  /** The pass's id in apple_passes. */
  serialNumber: string;
  authenticationToken: string;
  cafeName: string;
  stamps: number;
  program: { stampsRequired: number; rewardNameAr: string; rewardNameEn: string } | undefined;
  /** The card's QR token, or null for a pass of an earlier epoch (the card moved to another phone): voided. */
  qr: string | null;
  /** What the card shows of offers (loadCardOffer). */
  offers: { optedIn: boolean; offer: CardOffer | undefined };
  /** The feedback page of the card's latest feedback request (feedbackUrl, AC 37), if it has one. */
  feedbackUrl: string | undefined;
}

/**
 * A square PNG of one colour, for the Apple pass icon and the Google class logo. ponytail: a plain colour; the café's
 * own logo when cafés upload one.
 */
export function solidPng(size: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  // 8 bits per channel, RGB.
  header[8] = 8;
  header[9] = 2;
  // Each row: filter type 0, then the pixels.
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Apple's icon sizes: 29 points at 1x, 2x and 3x. */
const ICONS = { "icon.png": solidPng(29, PASS_BACKGROUND), "icon@2x.png": solidPng(58, PASS_BACKGROUND), "icon@3x.png": solidPng(87, PASS_BACKGROUND) };

/** A value for a pass.strings file, which passkit-generator writes between quotes as given. */
const stringsValue = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/**
 * Every text of the pass in one language: pass.json names these keys, and each language's pass.strings fills them in,
 * so Wallet shows the pass in the phone's language, Arabic or English (AC 10).
 */
function passStrings(lang: Lang, content: ApplePassContent): Record<string, string> {
  const { program } = content;
  const reward = program === undefined ? undefined : lang === "ar" ? program.rewardNameAr : program.rewardNameEn;
  // A voided pass says so in short on its front, where Wallet cuts long text, and in full on its back.
  const moved = content.qr === null;
  const strings: Record<string, string> = {
    description: t(lang, "passDescription", { cafe: content.cafeName }),
    stamps_label: t(lang, moved ? "passMovedLabel" : "passStampsLabel"),
    stamps_value: moved
      ? t(lang, "passMovedValue")
      : program === undefined
        ? count(lang, "stamps", content.stamps)
        : t(lang, "stampsProgress", { stamps: content.stamps, required: count(lang, "stamps", program.stampsRequired) }),
    about_label: t(lang, moved ? "passMovedLabel" : "passAboutLabel"),
    about_value: t(lang, moved ? "passMovedText" : "passAboutText"),
    // The stamps it takes show above, as "4 of 9 stamps".
    ...(reward === undefined ? {} : { reward_label: t(lang, "passRewardLabel"), reward_value: reward }),
    ...offerStrings(lang, content.offers.offer),
    ...(content.feedbackUrl === undefined ? {} : { feedback_label: t(lang, "passFeedbackLabel"), feedback_value: `${t(lang, "passFeedbackText")}\n${content.feedbackUrl}` }),
  };
  return Object.fromEntries(Object.entries(strings).map(([key, value]) => [key, stringsValue(value)]));
}

/** The offer field's texts: the offer's headline and details, or that there is none. */
function offerStrings(lang: Lang, offer: CardOffer | undefined): Record<string, string> {
  const text = offer === undefined ? undefined : offerText(lang, offer);
  return {
    offer_label: t(lang, "passOfferLabel"),
    offer_value: text?.headline ?? t(lang, "passNoOffer"),
    offer_change: t(lang, "passOfferChange"),
    ...(text === undefined ? {} : { offer_details_label: t(lang, "passOfferDetailsLabel"), offer_details_value: text.details }),
  };
}

/**
 * A card's offer field, on the front of an opted-in card's pass (AC 4): Wallet shows a lock-screen notification when a
 * field with a changeMessage changes value, so only an offer that may notify has one (announced today, CardOffer.mayNotify; AC 14). The field stays while
 * the card is opted in, saying there is no offer, so an ended offer goes away silently.
 */
function offerFields(content: ApplePassContent) {
  const { optedIn, offer } = content.offers;
  if (!optedIn || content.qr === null) {
    return { auxiliaryFields: [], backFields: [] };
  }
  return {
    auxiliaryFields: [{ key: "offer", label: "offer_label", value: "offer_value", ...(offer?.mayNotify === true ? { changeMessage: "offer_change" } : {}) }],
    backFields: offer === undefined ? [] : [{ key: "offer_details", label: "offer_details_label", value: "offer_details_value" }],
  };
}

/**
 * A signed .pkpass of a card (AC 10): its stamps, the reward and the card's QR, updated through the PassKit web
 * service at `${publicUrl}/passkit` (AC 11). Only the offer field can have a changeMessage (offerFields), so stamp
 * updates are silent: lock-screen notifications are kept for offers, at most one a day (AC 14). Sharing is off: the pass carries the card's QR.
 */
export function buildApplePass(config: ApplePassConfig, publicUrl: string, content: ApplePassContent): Buffer {
  const offer = offerFields(content);
  const json = {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeId,
    teamIdentifier: config.teamId,
    serialNumber: content.serialNumber,
    authenticationToken: content.authenticationToken,
    webServiceURL: new URL("/passkit", publicUrl).toString(),
    organizationName: content.cafeName,
    description: "description",
    logoText: content.cafeName,
    sharingProhibited: true,
    backgroundColor: `rgb(${PASS_BACKGROUND.join(", ")})`,
    foregroundColor: "rgb(255, 255, 255)",
    labelColor: "rgb(235, 214, 190)",
    ...(content.qr === null ? { voided: true } : { barcodes: [{ format: "PKBarcodeFormatQR", message: content.qr, messageEncoding: "iso-8859-1" }] }),
    storeCard: {
      primaryFields: [{ key: "stamps", label: "stamps_label", value: "stamps_value" }],
      secondaryFields: content.program === undefined || content.qr === null ? [] : [{ key: "reward", label: "reward_label", value: "reward_value" }],
      auxiliaryFields: offer.auxiliaryFields,
      // The feedback link is on the back, silently (AC 37): Wallet makes the URL in its text a link.
      backFields: [
        ...offer.backFields,
        ...(content.feedbackUrl === undefined || content.qr === null ? [] : [{ key: "feedback", label: "feedback_label", value: "feedback_value" }]),
        { key: "about", label: "about_label", value: "about_value" },
      ],
    },
  };
  const pass = new PKPass({ "pass.json": Buffer.from(JSON.stringify(json)), ...ICONS }, config.certificates);
  for (const lang of ["ar", "en"] as const) {
    pass.localize(lang, passStrings(lang, content));
  }
  return pass.getAsBuffer();
}
