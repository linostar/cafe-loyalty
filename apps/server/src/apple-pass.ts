import { createHmac } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { APPLE_PASS_LAYOUT_VERSION, offerText, stampsText, type CardOffer } from "@cafe-loyalty/db";
import type { CardColors, StampShape } from "@cafe-loyalty/shared";
import { PKPass } from "passkit-generator";
import sharp from "sharp";
import type { CustomerSecrets } from "./customer-crypto.js";
import { t, type Lang } from "./customer-html.js";
import { stampPicturePng } from "./stamp-picture.js";

/** Apple Wallet settings (APPLE_* variables): the pass type and team ids and the certificates that sign passes. */
export interface ApplePassConfig {
  passTypeId: string;
  teamId: string;
  /** PEM: the pass type certificate and its key, and Apple's WWDR intermediate certificate. */
  certificates: { signerCert: string; signerKey: string; wwdr: string };
}

// The pass layout this release builds (packages/db wallet.ts, where the worker's sweep reads it too).
export { APPLE_PASS_LAYOUT_VERSION };

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
  /** The café's card colours (#rrggbb). */
  colors: CardColors;
  /** The shape the café's stamps are drawn in, on the strip. */
  stampShape: StampShape;
  /** The café's logo as Apple's logo.png at 1x, 2x and 3x, or undefined: the pass then shows the café's name alone. */
  logo: { apple1x: Buffer; apple2x: Buffer; apple3x: Buffer } | undefined;
  /** The holder's name (cards.holder_name), or null on a card made before it was asked: the pass then has no name. */
  holderName: string | null;
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

/** A #rrggbb colour's channels. */
const channels = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** A #rrggbb colour as pass.json takes it. */
const rgb = (hex: string): string => `rgb(${channels(hex).join(", ")})`;

/** Apple's icon sizes, 29 points at 1x, 2x and 3x: squares of the card's background. */
const icons = (background: string) => {
  const fill = channels(background);
  return { "icon.png": solidPng(29, fill), "icon@2x.png": solidPng(58, fill), "icon@3x.png": solidPng(87, fill) };
};

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
    ...(moved ? { moved_label: t(lang, "passMovedLabel"), moved_value: t(lang, "passMovedValue") } : {}),
    // The strip shows the stamps; the back says them in words, for VoiceOver.
    ...(program === undefined ? {} : { stamps_value: stampsText(lang, content.stamps, program.stampsRequired) }),
    about_label: t(lang, moved ? "passMovedLabel" : "passAboutLabel"),
    about_value: t(lang, moved ? "passMovedText" : "passAboutText"),
    ...(reward === undefined ? {} : { reward_label: t(lang, "passRewardLabel"), reward_value: reward }),
    // The name as a string of its own, so no name can be read as another field's key.
    ...(content.holderName === null || moved ? {} : { holder_value: content.holderName }),
    ...offerStrings(lang, content.offers.offer),
    ...(content.feedbackUrl === undefined ? {} : { feedback_label: t(lang, "passFeedbackLabel"), feedback_value: `${t(lang, "passFeedbackText")}\n${content.feedbackUrl}` }),
  };
  return Object.fromEntries(Object.entries(strings).map(([key, value]) => [key, stringsValue(value)]));
}

/** The offer field's texts, when the card has an offer: its headline and details. */
function offerStrings(lang: Lang, offer: CardOffer | undefined): Record<string, string> {
  if (offer === undefined) {
    return {};
  }
  const text = offerText(lang, offer);
  return {
    offer_label: t(lang, "passOfferLabel"),
    offer_value: text.headline,
    offer_change: t(lang, "passOfferChange"),
    offer_details_label: t(lang, "passOfferDetailsLabel"),
    offer_details_value: text.details,
  };
}

/**
 * A card's offer field, on the front of an opted-in card's pass (AC 4), only while it has an offer: no field says
 * there is none. Wallet shows a lock-screen notification when a field with a changeMessage changes value, so only an
 * offer that may notify has one (announced today, CardOffer.mayNotify; AC 14); an ended offer's field goes away silently.
 */
function offerFields(content: ApplePassContent) {
  const { optedIn, offer } = content.offers;
  if (!optedIn || offer === undefined || content.qr === null) {
    return { auxiliaryFields: [], backFields: [] };
  }
  return {
    auxiliaryFields: [
      { key: "offer", label: "offer_label", value: "offer_value", textAlignment: START, ...(offer.mayNotify ? { changeMessage: "offer_change" } : {}) },
    ],
    backFields: [{ key: "offer_details", label: "offer_details_label", value: "offer_details_value" }],
  };
}

/**
 * The reward and the offer start-aligned in their row under the strip (left in English, right in Arabic), label and
 * value alike. A store card shows secondary and auxiliary fields in one row, so with an offer they sit side by side.
 */
const START = "PKTextAlignmentNatural";

/** Clear space above the café's logo, in points: Wallet puts the header's logo close to the pass's top edge. */
export const LOGO_TOP_SPACE = 6;

/**
 * The café's logo.png at Apple's three scales with LOGO_TOP_SPACE of transparency above it. Wallet fits a logo inside
 * 160×50 points, so a logo already 50 points tall is drawn slightly smaller to make room.
 */
async function spacedLogo(logo: { apple1x: Buffer; apple2x: Buffer; apple3x: Buffer }): Promise<Record<string, Buffer>> {
  const [one, two, three] = await Promise.all(
    [logo.apple1x, logo.apple2x, logo.apple3x].map((image, index) =>
      sharp(image)
        .extend({ top: LOGO_TOP_SPACE * (index + 1), background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    ),
  );
  return one === undefined || two === undefined || three === undefined ? {} : { "logo.png": one, "logo@2x.png": two, "logo@3x.png": three };
}

/** The strip at Apple's three scales: the card's stamps in the café's shape and colours. */
async function strips(content: ApplePassContent, required: number): Promise<Record<string, Buffer>> {
  const picture = { shape: content.stampShape, background: content.colors.background, foreground: content.colors.foreground, stamps: content.stamps, required };
  const [one, two, three] = await Promise.all([1, 2, 3].map((scale) => stampPicturePng(picture, scale)));
  return one === undefined || two === undefined || three === undefined ? {} : { "strip.png": one, "strip@2x.png": two, "strip@3x.png": three };
}

/**
 * A signed .pkpass of a card (AC 10): a strip picturing its stamps (no count or label on the front; the back says
 * them in words), the reward and the card's QR, updated through the PassKit web service at `${publicUrl}/passkit`
 * (AC 11). Only the offer field can have a changeMessage (offerFields), so stamp updates are silent: lock-screen
 * notifications are kept for offers, at most one a day (AC 14). Sharing is off: the pass carries the card's QR. A
 * voided pass (moved) says so in place of the strip; a card without a program has no stamps to show.
 */
export async function buildApplePass(config: ApplePassConfig, publicUrl: string, content: ApplePassContent): Promise<Buffer> {
  const offer = offerFields(content);
  const moved = content.qr === null;
  const { program } = content;
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
    // The café's colours: no field takes a changeMessage from them, so a new colour reaches the pass silently (AC 14).
    backgroundColor: rgb(content.colors.background),
    foregroundColor: rgb(content.colors.foreground),
    labelColor: rgb(content.colors.label),
    ...(content.qr === null ? { voided: true } : { barcodes: [{ format: "PKBarcodeFormatQR", message: content.qr, messageEncoding: "iso-8859-1" }] }),
    storeCard: {
      // The holder's name beside the logo, on a card that has one: a card without a name builds the pass as before.
      ...(content.holderName === null || moved ? {} : { headerFields: [{ key: "holder", value: "holder_value" }] }),
      primaryFields: moved ? [{ key: "moved", label: "moved_label", value: "moved_value" }] : [],
      secondaryFields: program === undefined || moved ? [] : [{ key: "reward", label: "reward_label", value: "reward_value", textAlignment: START }],
      auxiliaryFields: offer.auxiliaryFields,
      // The feedback link is on the back, silently (AC 37): Wallet makes the URL in its text a link.
      backFields: [
        ...(program === undefined || moved ? [] : [{ key: "stamps", value: "stamps_value" }]),
        ...offer.backFields,
        ...(content.feedbackUrl === undefined || moved ? [] : [{ key: "feedback", label: "feedback_label", value: "feedback_value" }]),
        { key: "about", label: "about_label", value: "about_value" },
      ],
    },
  };
  const logo = content.logo === undefined ? {} : await spacedLogo(content.logo);
  const strip = program === undefined || moved ? {} : await strips(content, program.stampsRequired);
  const pass = new PKPass({ "pass.json": Buffer.from(JSON.stringify(json)), ...icons(content.colors.background), ...logo, ...strip }, config.certificates);
  for (const lang of ["ar", "en"] as const) {
    pass.localize(lang, passStrings(lang, content));
  }
  return pass.getAsBuffer();
}
