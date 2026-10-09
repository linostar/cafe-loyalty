import { createHmac } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
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
 * The pass layout this release builds, stored per pass when a device receives it (AC 12). Bump it when the layout
 * changes, so the passes still on an older one can be found and pushed.
 */
export const APPLE_PASS_LAYOUT_VERSION = 1;

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
}

/** A square PNG of one colour, for the pass icon. ponytail: a plain colour; the café's own logo when cafés upload one. */
function solidPng(size: number, rgb: readonly [number, number, number]): Buffer {
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

const BACKGROUND = [74, 44, 42] as const;
/** Apple's icon sizes: 29 points at 1x, 2x and 3x. */
const ICONS = { "icon.png": solidPng(29, BACKGROUND), "icon@2x.png": solidPng(58, BACKGROUND), "icon@3x.png": solidPng(87, BACKGROUND) };

/** A value for a pass.strings file, which passkit-generator writes between quotes as given. */
const stringsValue = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/**
 * Every text of the pass in one language: pass.json names these keys, and each language's pass.strings fills them in,
 * so Wallet shows the pass in the phone's language, Arabic or English (AC 10).
 */
function passStrings(lang: Lang, content: ApplePassContent): Record<string, string> {
  const { program } = content;
  const reward = program === undefined ? undefined : lang === "ar" ? program.rewardNameAr : program.rewardNameEn;
  const strings: Record<string, string> = {
    description: t(lang, "passDescription", { cafe: content.cafeName }),
    stamps_label: t(lang, content.qr === null ? "passMovedLabel" : "passStampsLabel"),
    stamps_value:
      content.qr === null
        ? t(lang, "passMovedText")
        : program === undefined
          ? count(lang, "stamps", content.stamps)
          : t(lang, "stampsProgress", { stamps: content.stamps, required: count(lang, "stamps", program.stampsRequired) }),
    about_label: t(lang, "passAboutLabel"),
    about_value: t(lang, "passAboutText"),
    ...(program === undefined || reward === undefined
      ? {}
      : { reward_label: t(lang, "passRewardLabel"), reward_value: t(lang, "programSummary", { stamps: program.stampsRequired, reward }) }),
  };
  return Object.fromEntries(Object.entries(strings).map(([key, value]) => [key, stringsValue(value)]));
}

/**
 * A signed .pkpass of a card (AC 10): its stamps, the reward and the card's QR, updated through the PassKit web
 * service at `${publicUrl}/passkit` (AC 11). No field has a changeMessage, so updates (stamps) are silent: lock-screen
 * notifications are kept for offers, at most one a day (AC 14). Sharing is off: the pass carries the card's QR.
 */
export function buildApplePass(config: ApplePassConfig, publicUrl: string, content: ApplePassContent): Buffer {
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
    backgroundColor: `rgb(${BACKGROUND.join(", ")})`,
    foregroundColor: "rgb(255, 255, 255)",
    labelColor: "rgb(235, 214, 190)",
    ...(content.qr === null ? { voided: true } : { barcodes: [{ format: "PKBarcodeFormatQR", message: content.qr, messageEncoding: "iso-8859-1" }] }),
    storeCard: {
      primaryFields: [{ key: "stamps", label: "stamps_label", value: "stamps_value" }],
      secondaryFields: content.program === undefined || content.qr === null ? [] : [{ key: "reward", label: "reward_label", value: "reward_value" }],
      backFields: [{ key: "about", label: "about_label", value: "about_value" }],
    },
  };
  const pass = new PKPass({ "pass.json": Buffer.from(JSON.stringify(json)), ...ICONS }, config.certificates);
  for (const lang of ["ar", "en"] as const) {
    pass.localize(lang, passStrings(lang, content));
  }
  return pass.getAsBuffer();
}
