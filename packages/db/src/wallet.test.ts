import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CardOffer } from "./offers.js";
import { PASS_TEXT, googleClassId, googleLoyaltyClass, googleLoyaltyObject, googleObjectId, googleOfferMessage, offerText, signJwt, stampsText } from "./wallet.js";

const ISSUER = "3388000000012345678";
const PUBLIC_URL = "https://card.example.test";
const CONTENT = {
  cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d",
  cardId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40",
  epoch: 2,
  holderName: null,
  stamps: 4,
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
  qr: "qr-token",
  offer: undefined,
  feedbackUrl: undefined,
  look: { colors: { background: "#1f5a85", foreground: "#ffffff", label: "#e5eff7" }, stampShape: "cup" as const },
};

const OFFER: CardOffer = {
  kind: "campaign",
  campaignId: "2d7e0c1b-5a4f-4e3d-9c2b-1a0f9e8d7c6b",
  nameAr: "عصرية",
  nameEn: "Afternoon",
  discount: { kind: "percent", value: 20 },
  weekdays: [1, 3, 5],
  startsMinute: 14 * 60,
  endsMinute: 24 * 60,
  orderTypes: [
    { nameAr: "إسبريسو", nameEn: "Espresso" },
    { nameAr: "لاتيه", nameEn: "Latte" },
  ],
  announcedAt: new Date("2026-10-05T12:00:00Z"),
  mayNotify: true,
};

describe("offer text", () => {
  it("names the offer, its discount, days, hours and order types, in English and Arabic (AC 14)", () => {
    expect(offerText("en", OFFER)).toEqual({ headline: "Afternoon · 20% off", details: "Monday, Wednesday, and Friday, 14:00–00:00, on Espresso and Latte." });
    const ar = offerText("ar", OFFER);
    // Latin digits, like the pass's stamps and hours.
    expect(ar.headline).toBe("عصرية · خصم 20%");
    expect(ar.details).toContain("الاثنين");
    expect(ar.details).toContain("14:00–00:00");
    expect(ar.details).toContain("لاتيه");
  });

  it("says every day for a campaign that runs all week, and an amount off in dollars", () => {
    const text = offerText("en", { ...OFFER, weekdays: [1, 2, 3, 4, 5, 6, 7], discount: { kind: "amount", value: 50 }, orderTypes: [{ nameAr: "إسبريسو", nameEn: "Espresso" }] });
    expect(text).toEqual({ headline: "Afternoon · $0.50 off", details: "Every day, 14:00–00:00, on Espresso." });
    expect(offerText("ar", { ...OFFER, discount: { kind: "amount", value: 50 } }).headline).toBe("عصرية · خصم $0.50");
    // Midnight to midnight reads as all day, not as an empty 00:00–00:00.
    expect(offerText("en", { ...OFFER, startsMinute: 0, endsMinute: 1440 }).details).toBe("Monday, Wednesday, and Friday, all day, on Espresso and Latte.");
    expect(offerText("ar", { ...OFFER, startsMinute: 0, endsMinute: 1440 }).details).toContain("طوال اليوم");
  });
});

describe("win-back offer text", () => {
  const WIN_BACK: CardOffer = {
    kind: "win_back",
    offerId: "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e",
    discount: { kind: "percent", value: 15 },
    lastDay: "2026-10-24",
    announcedAt: new Date("2026-10-10T09:00:00Z"),
    mayNotify: true,
  };

  it("welcomes the customer back with the discount and its last day, in English and Arabic (AC 36)", () => {
    expect(offerText("en", WIN_BACK)).toEqual({ headline: "Welcome back · 15% off", details: "On your next visit, until October 24." });
    expect(offerText("ar", WIN_BACK)).toEqual({ headline: "أهلاً بعودتك · خصم 15%", details: "في زيارتك القادمة، حتى 24 تشرين الأول." });
    expect(googleOfferMessage(WIN_BACK)).toMatchObject({ id: `winback-${WIN_BACK.offerId}`, body: "Welcome back · 15% off", messageType: "TEXT_AND_NOTIFY" });
  });
});

describe("Google Wallet objects", () => {
  it("derives class and object ids from the café, the card and its epoch (AC 12)", () => {
    expect(googleClassId(ISSUER, CONTENT.cafeId)).toBe(`${ISSUER}.cafe-${CONTENT.cafeId}`);
    expect(googleObjectId(ISSUER, CONTENT.cardId, 2)).toBe(`${ISSUER}.card-${CONTENT.cardId}-2`);
    // Google's id rule: the issuer id, a dot, then letters, digits, '.', '_' or '-'.
    expect(googleObjectId(ISSUER, CONTENT.cardId, 2)).toMatch(/^\d+\.[A-Za-z0-9._-]+$/);
  });

  it("builds the café's class with its own logo and background, or the product's logo", () => {
    const hash = Buffer.alloc(32, 0xab);
    expect(
      googleLoyaltyClass(ISSUER, { id: CONTENT.cafeId, name: "Café Nour", colors: { background: "#1f5a85", foreground: "#ffffff", label: "#e5eff7" }, logoHash: hash }, "https://card.example.test"),
    ).toMatchObject({ issuerName: "Café Nour", hexBackgroundColor: "#1f5a85", programLogo: { sourceUri: { uri: `https://card.example.test/logos/${"ab".repeat(32)}.png` } } });
  });

  it("builds the café's class in both languages", () => {
    const branding = { id: CONTENT.cafeId, name: "Café Najjar", colors: { background: "#4a2c2a", foreground: "#ffffff", label: "#ebd6be" }, logoHash: null };
    expect(googleLoyaltyClass(ISSUER, branding, "https://card.example.test")).toEqual({
      id: googleClassId(ISSUER, CONTENT.cafeId),
      issuerName: "Café Najjar",
      programName: "Loyalty card",
      localizedProgramName: { defaultValue: { language: "en", value: "Loyalty card" }, translatedValues: [{ language: "ar", value: "بطاقة الولاء" }] },
      programLogo: { sourceUri: { uri: "https://card.example.test/wallet/logo.png" } },
      hexBackgroundColor: "#4a2c2a",
      reviewStatus: "UNDER_REVIEW",
    });
  });

  it("builds the current card's object: QR, a picture of its stamps, reward and help, in Arabic and English (AC 10)", () => {
    const object = googleLoyaltyObject(ISSUER, CONTENT, PUBLIC_URL);
    expect(object).toMatchObject({
      id: googleObjectId(ISSUER, CONTENT.cardId, 2),
      classId: googleClassId(ISSUER, CONTENT.cafeId),
      state: "ACTIVE",
      barcode: { type: "QR_CODE", value: "qr-token" },
      // The café's shape and colours and the card's count make the address; read aloud as words.
      heroImage: {
        sourceUri: { uri: "https://card.example.test/stamps/v3/cup-1f5a85-ffffff-4-9.png" },
        contentDescription: { defaultValue: { language: "en", value: "4 of 9 stamps" }, translatedValues: [{ language: "ar", value: stampsText("ar", 4, 9) }] },
      },
    });
    // No count or "Stamps" label on the front: the picture shows them.
    expect(object).not.toHaveProperty("loyaltyPoints");
    expect(object.textModulesData.map((module) => [module.id, module.localizedBody.translatedValues[0]?.value])).toEqual([
      ["reward", "قهوة مجانية"],
      ["about", PASS_TEXT.ar.passAboutText],
    ]);
    // Silent: no field asks Google to notify (AC 14).
    expect(JSON.stringify(object)).not.toContain("notifyPreference");
    // Past full (stamps keep counting): every stamp full, at an address the server draws.
    expect(googleLoyaltyObject(ISSUER, { ...CONTENT, stamps: 11 }, PUBLIC_URL)).toMatchObject({ heroImage: { sourceUri: { uri: "https://card.example.test/stamps/v3/cup-1f5a85-ffffff-9-9.png" } } });
    // Without a program a card collects no stamps: no picture.
    expect(googleLoyaltyObject(ISSUER, { ...CONTENT, program: undefined }, PUBLIC_URL)).not.toHaveProperty("heroImage");
  });

  it("names the holder as Google's member name on a card that has one, and builds a nameless card's object as before", () => {
    expect(googleLoyaltyObject(ISSUER, { ...CONTENT, holderName: "رانيا حداد" }, PUBLIC_URL)).toMatchObject({ accountName: "رانيا حداد" });
    expect(googleLoyaltyObject(ISSUER, CONTENT, PUBLIC_URL)).not.toHaveProperty("accountName");
    // An object of an earlier epoch (moved) says only that.
    expect(googleLoyaltyObject(ISSUER, { ...CONTENT, holderName: "رانيا حداد", qr: null }, PUBLIC_URL)).not.toHaveProperty("accountName");
  });

  it("says a card's stamps out of the program's in both languages", () => {
    expect(stampsText("en", 4, 9)).toBe("4 of 9 stamps");
    expect(stampsText("en", 0, 1)).toBe("0 of 1 stamp");
    expect(stampsText("ar", 4, 9)).toBe("⁨4⁩ من ⁨9⁩ أختام");
    expect(stampsText("ar", 1, 2)).toBe("⁨1⁩ من ختمين");
    expect(stampsText("ar", 3, 12)).toBe("⁨3⁩ من ⁨12⁩ ختمًا");
  });

  it("shows the card's offer first, and announces it with one notifying message named after the campaign (AC 14)", () => {
    const object = googleLoyaltyObject(ISSUER, { ...CONTENT, offer: OFFER }, PUBLIC_URL);
    expect(object.textModulesData.map((module) => module.id)).toEqual(["offer", "reward", "about"]);
    expect(object.textModulesData[0]).toMatchObject({ header: "Afternoon · 20% off", body: offerText("en", OFFER).details });
    expect(object.textModulesData[0]?.localizedHeader.translatedValues[0]?.value).toBe(offerText("ar", OFFER).headline);
    expect(googleOfferMessage(OFFER)).toEqual({
      id: `offer-${OFFER.campaignId}`,
      header: "New offer",
      body: "Afternoon · 20% off",
      localizedHeader: { defaultValue: { language: "en", value: "New offer" }, translatedValues: [{ language: "ar", value: "عرض جديد" }] },
      localizedBody: { defaultValue: { language: "en", value: "Afternoon · 20% off" }, translatedValues: [{ language: "ar", value: offerText("ar", OFFER).headline }] },
      messageType: "TEXT_AND_NOTIFY",
    });
    // Google's message ids: letters, digits, '.', '_' or '-'.
    expect(googleOfferMessage(OFFER).id).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("links to the latest visit's feedback page, in Arabic and English, without notifying (AC 37)", () => {
    const object = googleLoyaltyObject(ISSUER, { ...CONTENT, feedbackUrl: "https://card.example.test/f/fake-token" }, PUBLIC_URL);
    expect(object.state === "ACTIVE" ? object.linksModuleData?.uris : undefined).toEqual([
      {
        id: "feedback",
        uri: "https://card.example.test/f/fake-token",
        description: "How was your visit? Tell us",
        localizedDescription: { defaultValue: { language: "en", value: "How was your visit? Tell us" }, translatedValues: [{ language: "ar", value: "كيف كانت زيارتك؟ أخبرنا" }] },
      },
    ]);
    expect(JSON.stringify(object)).not.toContain("notifyPreference");
    expect(googleLoyaltyObject(ISSUER, CONTENT, PUBLIC_URL)).not.toHaveProperty("linksModuleData");
  });

  it("builds an earlier epoch's object INACTIVE, without the QR or stamps (AC 8)", () => {
    const object = googleLoyaltyObject(ISSUER, { ...CONTENT, qr: null, offer: OFFER }, PUBLIC_URL);
    expect(object).toEqual({
      id: googleObjectId(ISSUER, CONTENT.cardId, 2),
      classId: googleClassId(ISSUER, CONTENT.cafeId),
      state: "INACTIVE",
      textModulesData: [expect.objectContaining({ id: "moved", header: PASS_TEXT.en.passMovedLabel, body: PASS_TEXT.en.passMovedText })],
    });
  });

  it("signs JWTs with RS256", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = signJwt({ aud: "google" }, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const [header = "", claims = "", signature = ""] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))).toEqual({ aud: "google" });
    expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url")).toBe(true);
  });
});
