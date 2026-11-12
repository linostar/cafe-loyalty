import { createPrivateKey, createSign } from "node:crypto";
import { formatUsd, plural, type Plural } from "@cafe-loyalty/shared";
import { z } from "zod";
import { cafeLogoPath, stampPicturePath, type CafeBranding } from "./branding.js";
import { offerKey, type CardOffer } from "./offers.js";

/**
 * Text on wallet passes in both languages (AC 10), shared by the server (the customer pages' messages, Apple passes
 * and Google save links) and the worker (Google pass updates). `{cafe}` is filled in by the caller.
 */
export const PASS_TEXT = {
  en: {
    passDescription: "Loyalty card at {cafe}",
    passProgramName: "Loyalty card",
    passRewardLabel: "Reward",
    passAboutLabel: "How it works",
    passAboutText: "Show this card to the barista to collect stamps. Your stamps update here by themselves.",
    passMovedLabel: "Card moved",
    passMovedValue: "Use your new card",
    passMovedText: "This card was restored on another phone. Use the card there.",
    passOfferLabel: "Offer",
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
    // Not a promise of a Google review: the café may have no review link.
    passFeedbackText: "Tell the café privately how your visit went.",
    passReviewLabel: "Leave a review",
    passReviewLink: "Leave a review on Google",
    passReviewText: "Tell others about the café on Google.",
  },
  ar: {
    passDescription: "بطاقة الولاء في {cafe}",
    passProgramName: "بطاقة الولاء",
    passRewardLabel: "المكافأة",
    passAboutLabel: "كيف تعمل",
    passAboutText: "أظهر هذه البطاقة للباريستا لجمع الأختام. تُحدَّث أختامك هنا تلقائياً.",
    passMovedLabel: "نُقلت البطاقة",
    passMovedValue: "استخدم بطاقتك الجديدة",
    passMovedText: "استُعيدت هذه البطاقة على هاتف آخر. استخدم البطاقة هناك.",
    passOfferLabel: "العرض",
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
    passFeedbackText: "أخبر المقهى بشكل خاص كيف كانت زيارتك.",
    passReviewLabel: "اترك تقييماً",
    passReviewLink: "اترك تقييماً على Google",
    passReviewText: "أخبر الآخرين عن المقهى على Google.",
  },
} as const satisfies Record<"ar" | "en", Record<string, string>>;

type PassTextKey = keyof (typeof PASS_TEXT)["en"];

/** A card's stamps out of the program's ("4 of 9 stamps"), `{n}` being the stamps it takes. */
const STAMPS_OF: Plural = {
  en: { one: "{stamps} of {n} stamp", other: "{stamps} of {n} stamps" },
  ar: { zero: "{stamps} من {n} ختم", one: "{stamps} من ختم واحد", two: "{stamps} من ختمين", few: "{stamps} من {n} أختام", many: "{stamps} من {n} ختمًا", other: "{stamps} من {n} ختم" },
};

/**
 * A card's stamps in words, for what reads the pass aloud (the Apple pass's back, the Google stamp picture's
 * description): passes show the stamps as a picture, never as this text on their front.
 */
export const stampsText = (lang: "ar" | "en", stamps: number, required: number): string => plural(lang, STAMPS_OF, required, { stamps });

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
  // In Latin digits in both languages, like the hours.
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

/** The product's espresso (RGB): its Google class logo, for cafés without a logo of their own. */
export const PASS_BACKGROUND = [74, 44, 42] as const;

/**
 * The pass layouts this release builds, stored per pass (AC 12): bump one when its wallet's layout changes. The
 * worker's sweep (mark_outdated_passes, migrations 0025, 0027 and 0029) marks every pass on an older layout changed
 * and records the new one, so passes nobody updates otherwise get it too (Apple: 3 drew the stamps on a strip; Google:
 * 2 made them the hero image; Apple 4 and Google 3: rows of at most 5 stamps; Apple 5 and Google 4: full stamps as big
 * as empty ones, and on Apple the reward and offer centred and space above the logo; Apple 6: the reward and offer
 * start-aligned, migration 0035; Apple 7 and Google 5: the café's review link on every pass, migration 0036). An Apple
 * pass on another layout also counts as changed when next fetched (passkit-routes.ts).
 */
export const APPLE_PASS_LAYOUT_VERSION = 7;
export const GOOGLE_PASS_LAYOUT_VERSION = 5;

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

/**
 * A café's loyalty class: its name, logo (its own, or the product's), card background and review link (on every pass of
 * the café, beside an object's own links); Google picks the text colour. Written with the café's first object, and again
 * by the worker whenever it is built differently (cafes.google_class_hash).
 */
export function googleLoyaltyClass(issuerId: string, cafe: Pick<CafeBranding, "id" | "name" | "colors" | "logoHash" | "reviewUrl">, publicUrl: string) {
  return {
    id: googleClassId(issuerId, cafe.id),
    issuerName: cafe.name,
    programName: PASS_TEXT.en.passProgramName,
    localizedProgramName: passText("passProgramName"),
    programLogo: { sourceUri: { uri: cafe.logoHash === null ? googleLogoUrl(publicUrl) : new URL(cafeLogoPath(cafe.logoHash), publicUrl).toString() } },
    hexBackgroundColor: cafe.colors.background,
    // Always there, whoever the customer and however the visit went: never gated (AC 37).
    ...(cafe.reviewUrl === null
      ? {}
      : { linksModuleData: { uris: [{ id: "review", uri: cafe.reviewUrl, description: PASS_TEXT.en.passReviewLink, localizedDescription: passText("passReviewLink") }] } }),
    reviewStatus: "UNDER_REVIEW",
  };
}

export interface GooglePassContent {
  cafeId: string;
  cardId: string;
  epoch: number;
  /** The holder's name (cards.holder_name), or null on a card made before it was asked: the object then has none. */
  holderName: string | null;
  stamps: number;
  program: { stampsRequired: number; rewardNameAr: string; rewardNameEn: string } | undefined;
  /** The card's QR token, or null for an object of an earlier epoch (the card moved to another phone): INACTIVE. */
  qr: string | null;
  /** The offer the card shows (loadCardOffer), if any. */
  offer: CardOffer | undefined;
  /** The feedback page of the card's latest feedback request (feedbackUrl, AC 37), if it has one. */
  feedbackUrl: string | undefined;
  /** How the café draws its stamps: the picture of them is in its shape and colours (loadCafeBranding). */
  look: Pick<CafeBranding, "colors" | "stampShape">;
}

/** The public address of the picture of a card's stamps (stampPicturePath), for the pass's hero image. */
export const stampPictureUrl = (publicUrl: string, look: Pick<CafeBranding, "colors" | "stampShape">, stamps: number, required: number): string =>
  new URL(stampPicturePath({ shape: look.stampShape, background: look.colors.background, foreground: look.colors.foreground, stamps, required }), publicUrl).toString();

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
 * A card's whole loyalty object as it is now (AC 10): the offer it shows, a picture of its stamps (the hero image, read
 * aloud as "4 of 9 stamps"), the reward and the card's QR, or, for an earlier epoch, an INACTIVE object without them
 * (AC 8). No stamps without a program: a card cannot collect any then. Written whole, so every write leaves Google with
 * the current card. Writes are silent (no notifyPreference); only an offer's message notifies (googleOfferMessage, AC 14).
 */
export function googleLoyaltyObject(issuerId: string, content: GooglePassContent, publicUrl: string) {
  const ids = { id: googleObjectId(issuerId, content.cardId, content.epoch), classId: googleClassId(issuerId, content.cafeId) };
  if (content.qr === null) {
    return { ...ids, state: "INACTIVE" as const, textModulesData: [textModule("moved", passText("passMovedLabel"), passText("passMovedText"))] };
  }
  const { program } = content;
  return {
    ...ids,
    state: "ACTIVE" as const,
    // The holder's name, Google's own member field, on a card that has one: a card without a name builds as before.
    ...(content.holderName === null ? {} : { accountName: content.holderName }),
    barcode: { type: "QR_CODE", value: content.qr },
    ...(program === undefined
      ? {}
      : {
          heroImage: {
            sourceUri: { uri: stampPictureUrl(publicUrl, content.look, content.stamps, program.stampsRequired) },
            contentDescription: localized(stampsText("en", content.stamps, program.stampsRequired), stampsText("ar", content.stamps, program.stampsRequired)),
          },
        }),
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
