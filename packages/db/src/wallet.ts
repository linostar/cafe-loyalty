import { createPrivateKey, createSign } from "node:crypto";
import { formatUsd } from "@cafe-loyalty/shared";
import { z } from "zod";
import { offerKey, type CardOffer } from "./offers.js";

/**
 * Text on wallet passes in both languages (AC 10), shared by the server (the customer pages' messages, Apple passes
 * and Google save links) and the worker (Google pass updates). `{cafe}` is filled in by the caller.
 */
export const PASS_TEXT = {
  en: {
    passDescription: "Loyalty card at {cafe}",
    passProgramName: "Loyalty card",
    passStampsLabel: "Stamps",
    passRewardLabel: "Reward",
    passAboutLabel: "How it works",
    passAboutText: "Show this card to the barista to collect stamps. Your stamps update here by themselves.",
    passMovedLabel: "Card moved",
    passMovedValue: "Use your new card",
    passMovedText: "This card was restored on another phone. Use the card there.",
    passOfferLabel: "Offer",
    passNoOffer: "None right now",
    passOfferChange: "New offer: %@",
    passOfferNew: "New offer",
    passOfferDetailsLabel: "Offer details",
    passOfferHeadline: "{name} · {discount} off",
    passOfferDetails: "{days}, {hours}, on {items}.",
    passOfferEveryDay: "Every day",
    passOfferAllDay: "all day",
    passWinBackHeadline: "Welcome back · {discount} off",
    passWinBackDetails: "On your next visit, until {date}.",
    passFeedbackLabel: "How was your visit?",
    passFeedbackLink: "Tell us",
    passFeedbackText: "Send the café a private message, or review it on Google.",
  },
  ar: {
    passDescription: "بطاقة الولاء في {cafe}",
    passProgramName: "بطاقة الولاء",
    passStampsLabel: "الأختام",
    passRewardLabel: "المكافأة",
    passAboutLabel: "كيف تعمل",
    passAboutText: "أظهر هذه البطاقة للباريستا لجمع الأختام. تُحدَّث أختامك هنا تلقائياً.",
    passMovedLabel: "نُقلت البطاقة",
    passMovedValue: "استخدم بطاقتك الجديدة",
    passMovedText: "استُعيدت هذه البطاقة على هاتف آخر. استخدم البطاقة هناك.",
    passOfferLabel: "العرض",
    passNoOffer: "لا عرض حالياً",
    passOfferChange: "عرض جديد: %@",
    passOfferNew: "عرض جديد",
    passOfferDetailsLabel: "تفاصيل العرض",
    passOfferHeadline: "{name} · خصم {discount}",
    passOfferDetails: "{days}، {hours}، على {items}.",
    passOfferEveryDay: "كل يوم",
    passOfferAllDay: "طوال اليوم",
    passWinBackHeadline: "أهلاً بعودتك · خصم {discount}",
    passWinBackDetails: "في زيارتك القادمة، حتى {date}.",
    passFeedbackLabel: "كيف كانت زيارتك؟",
    passFeedbackLink: "أخبرنا",
    passFeedbackText: "أرسل إلى المقهى رسالة خاصة، أو قيّمه على Google.",
  },
} as const satisfies Record<"ar" | "en", Record<string, string>>;

type PassTextKey = keyof (typeof PASS_TEXT)["en"];

const LOCALES = { ar: "ar-LB", en: "en-US" } as const;

/** A local minute of the day as 24-hour time; the end of the day (1440) is 00:00, as the dashboard shows it. */
const clock = (minute: number): string => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * An offer's text in one language (AC 14), the same on Apple and Google passes: the headline ("Afternoon espresso · 20%
 * off", "Welcome back · 15% off"), which is what notifies, and its details (a campaign's days, hours and order types,
 * or a win-back offer's last day, AC 36).
 */
export function offerText(lang: "ar" | "en", offer: CardOffer): { headline: string; details: string } {
  const text = PASS_TEXT[lang];
  const locale = LOCALES[lang];
  // In Latin digits in both languages, like the pass's stamps ("4/9") and hours.
  const discount = offer.discount.kind === "percent" ? `${String(offer.discount.value)}%` : formatUsd(offer.discount.value, "en");
  if (offer.kind === "win_back") {
    // The day as stored, read as a UTC date: the café's time zone already chose it.
    const date = new Intl.DateTimeFormat(`${locale}-u-nu-latn`, { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${offer.lastDay}T00:00:00Z`));
    return { headline: text.passWinBackHeadline.replace("{discount}", discount), details: text.passWinBackDetails.replace("{date}", date) };
  }
  const list = (items: readonly string[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  const days =
    offer.weekdays.length === 7
      ? text.passOfferEveryDay
      : // 1 January 2024 was a Monday, ISO weekday 1.
        list(offer.weekdays.map((day) => weekday.format(new Date(Date.UTC(2024, 0, day)))));
  return {
    headline: text.passOfferHeadline.replace("{name}", lang === "ar" ? offer.nameAr : offer.nameEn).replace("{discount}", discount),
    details: text.passOfferDetails
      .replace("{days}", days)
      .replace("{hours}", offer.startsMinute === 0 && offer.endsMinute === 1440 ? text.passOfferAllDay : `${clock(offer.startsMinute)}–${clock(offer.endsMinute)}`)
      .replace("{items}", list(offer.orderTypes.map((type) => (lang === "ar" ? type.nameAr : type.nameEn)))),
  };
}

/** The passes' background colour (RGB), on Apple and Google alike. */
export const PASS_BACKGROUND = [74, 44, 42] as const;

/** Google Wallet settings (GOOGLE_WALLET_* variables). */
export interface GoogleWalletConfig {
  /** The issuer id from the Google Pay & Wallet Console. */
  issuerId: string;
  /** The service account that signs save links and calls the Wallet API. */
  serviceAccount: { email: string; privateKey: string };
}

export const googleIssuerIdSchema = z.string().regex(/^\d{1,30}$/, "Use the issuer id from the Google Pay & Wallet Console (digits only).");

/**
 * A setting holding a Google service account's JSON key file, base64-encoded on one line (base64 -w0), as both the
 * server and the worker take it. Parses to its email and RSA private key; the error never echoes the value.
 */
export const googleServiceAccountSchema = z.string().transform((value, context) => {
  const message = "Use the service account's JSON key file, base64-encoded on one line (base64 -w0).";
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    context.addIssue({ code: "custom", message });
    return z.NEVER;
  }
  const key = z.object({ client_email: z.email(), private_key: z.string() }).safeParse(parsed);
  try {
    if (key.success && createPrivateKey(key.data.private_key).asymmetricKeyType === "rsa") {
      return { email: key.data.client_email, privateKey: key.data.private_key };
    }
  } catch {
    // Not a private key: reported below.
  }
  context.addIssue({ code: "custom", message });
  return z.NEVER;
});

/** A JWT signed with RS256, as Google takes them for save links and service account sign-in. */
export function signJwt(claims: Readonly<Record<string, unknown>>, privateKey: string): string {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

/**
 * A café's loyalty class id and a card's object id at one epoch (AC 12): derived, never stored, so a retried write
 * updates the same class and object rather than making new ones, and a new epoch (recovery) gets a new object.
 */
export const googleClassId = (issuerId: string, cafeId: string): string => `${issuerId}.cafe-${cafeId}`;
export const googleObjectId = (issuerId: string, cardId: string, epoch: number): string => `${issuerId}.card-${cardId}-${String(epoch)}`;

/** Where Google fetches the cafés' class logo: a public image the server serves at this path of PUBLIC_URL. */
export const googleLogoUrl = (publicUrl: string): string => new URL("/wallet/logo.png", publicUrl).toString();

/** Google's LocalizedString: English by default, Arabic for phones set to Arabic. */
const localized = (en: string, ar: string) => ({ defaultValue: { language: "en", value: en }, translatedValues: [{ language: "ar", value: ar }] });
const passText = (key: PassTextKey) => localized(PASS_TEXT.en[key], PASS_TEXT.ar[key]);

/** A text module of a Google object: a localised header and body. */
const textModule = (id: string, header: ReturnType<typeof localized>, body: ReturnType<typeof localized>) => ({
  id,
  header: header.defaultValue.value,
  body: body.defaultValue.value,
  localizedHeader: header,
  localizedBody: body,
});

/** A café's loyalty class: its name and logo. Written when it does not exist yet, never updated afterwards. */
export function googleLoyaltyClass(issuerId: string, cafe: { id: string; name: string }, logoUrl: string) {
  return {
    id: googleClassId(issuerId, cafe.id),
    issuerName: cafe.name,
    programName: PASS_TEXT.en.passProgramName,
    localizedProgramName: passText("passProgramName"),
    programLogo: { sourceUri: { uri: logoUrl } },
    hexBackgroundColor: `#${PASS_BACKGROUND.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
    reviewStatus: "UNDER_REVIEW",
  };
}

export interface GooglePassContent {
  cafeId: string;
  cardId: string;
  epoch: number;
  stamps: number;
  program: { stampsRequired: number; rewardNameAr: string; rewardNameEn: string } | undefined;
  /** The card's QR token, or null for an object of an earlier epoch (the card moved to another phone): INACTIVE. */
  qr: string | null;
  /** The offer the card shows (loadCardOffer), if any. */
  offer: CardOffer | undefined;
  /** The feedback page of the card's latest feedback request (feedbackUrl, AC 37), if it has one. */
  feedbackUrl: string | undefined;
}

/** An offer's text in both languages, as a header and body of a Google object. */
const offerTexts = (offer: CardOffer) => {
  const en = offerText("en", offer);
  const ar = offerText("ar", offer);
  return { headline: localized(en.headline, ar.headline), details: localized(en.details, ar.details) };
};

/**
 * The message that announces an offer on a Google pass (AC 14): added once per pass with TEXT_AND_NOTIFY, Google's
 * one way to notify (field updates notify only for fields Google allows). Its id is the offer's (offerKey): a card is
 * given each campaign, and each win-back offer, once.
 */
export function googleOfferMessage(offer: CardOffer) {
  const { headline } = offerTexts(offer);
  const header = passText("passOfferNew");
  return {
    id: offerKey(offer),
    header: header.defaultValue.value,
    body: headline.defaultValue.value,
    localizedHeader: header,
    localizedBody: headline,
    messageType: "TEXT_AND_NOTIFY" as const,
  };
}

/**
 * A card's whole loyalty object as it is now (AC 10): the offer it shows, the stamps, the reward and the card's QR, or,
 * for an earlier epoch, an INACTIVE object without them (AC 8). Written whole, so every write leaves Google with the
 * current card. Writes are silent (no notifyPreference); only an offer's message notifies (googleOfferMessage, AC 14).
 */
export function googleLoyaltyObject(issuerId: string, content: GooglePassContent) {
  const ids = { id: googleObjectId(issuerId, content.cardId, content.epoch), classId: googleClassId(issuerId, content.cafeId) };
  if (content.qr === null) {
    return { ...ids, state: "INACTIVE" as const, textModulesData: [textModule("moved", passText("passMovedLabel"), passText("passMovedText"))] };
  }
  const { program } = content;
  return {
    ...ids,
    state: "ACTIVE" as const,
    barcode: { type: "QR_CODE", value: content.qr },
    loyaltyPoints: {
      label: PASS_TEXT.en.passStampsLabel,
      localizedLabel: passText("passStampsLabel"),
      // "4/9": the stamps it takes are shown with them, in digits both languages read.
      balance: program === undefined ? { int: content.stamps } : { string: `${String(content.stamps)}/${String(program.stampsRequired)}` },
    },
    textModulesData: [
      ...(content.offer === undefined ? [] : [textModule("offer", offerTexts(content.offer).headline, offerTexts(content.offer).details)]),
      ...(program === undefined ? [] : [textModule("reward", passText("passRewardLabel"), localized(program.rewardNameEn, program.rewardNameAr))]),
      textModule("about", passText("passAboutLabel"), passText("passAboutText")),
    ],
    // The feedback link, silently (AC 37; only an offer's message notifies, AC 14).
    ...(content.feedbackUrl === undefined
      ? {}
      : {
          linksModuleData: {
            uris: [
              {
                id: "feedback",
                uri: content.feedbackUrl,
                description: `${PASS_TEXT.en.passFeedbackLabel} ${PASS_TEXT.en.passFeedbackLink}`,
                localizedDescription: localized(
                  `${PASS_TEXT.en.passFeedbackLabel} ${PASS_TEXT.en.passFeedbackLink}`,
                  `${PASS_TEXT.ar.passFeedbackLabel} ${PASS_TEXT.ar.passFeedbackLink}`,
                ),
              },
            ],
          },
        }),
  };
}

export type GoogleLoyaltyClass = ReturnType<typeof googleLoyaltyClass>;
export type GoogleLoyaltyObject = ReturnType<typeof googleLoyaltyObject>;
export type GoogleOfferMessage = ReturnType<typeof googleOfferMessage>;
