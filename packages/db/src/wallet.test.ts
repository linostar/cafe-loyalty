import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CardOffer } from "./offers.js";
import { PASS_TEXT, googleClassId, googleLoyaltyClass, googleLoyaltyObject, googleObjectId, googleOfferMessage, offerText, signJwt } from "./wallet.js";

const ISSUER = "3388000000012345678";
const CONTENT = {
  cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d",
  cardId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40",
  epoch: 2,
  stamps: 4,
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
  qr: "qr-token",
  offer: undefined,
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

  it("builds the café's class in both languages", () => {
    expect(googleLoyaltyClass(ISSUER, { id: CONTENT.cafeId, name: "Café Najjar" }, "https://card.example.test/wallet/logo.png")).toEqual({
      id: googleClassId(ISSUER, CONTENT.cafeId),
      issuerName: "Café Najjar",
      programName: "Loyalty card",
      localizedProgramName: { defaultValue: { language: "en", value: "Loyalty card" }, translatedValues: [{ language: "ar", value: "بطاقة الولاء" }] },
      programLogo: { sourceUri: { uri: "https://card.example.test/wallet/logo.png" } },
      hexBackgroundColor: "#4a2c2a",
      reviewStatus: "UNDER_REVIEW",
    });
  });

  it("builds the current card's object: QR, stamps out of the program's, reward and help, in Arabic and English (AC 10)", () => {
    const object = googleLoyaltyObject(ISSUER, CONTENT);
    expect(object).toMatchObject({
      id: googleObjectId(ISSUER, CONTENT.cardId, 2),
      classId: googleClassId(ISSUER, CONTENT.cafeId),
      state: "ACTIVE",
      barcode: { type: "QR_CODE", value: "qr-token" },
      loyaltyPoints: { label: "Stamps", balance: { string: "4/9" } },
    });
    expect(object.textModulesData.map((module) => [module.id, module.localizedBody.translatedValues[0]?.value])).toEqual([
      ["reward", "قهوة مجانية"],
      ["about", PASS_TEXT.ar.passAboutText],
    ]);
    // Silent: no field asks Google to notify (AC 14).
    expect(JSON.stringify(object)).not.toContain("notifyPreference");
    expect(googleLoyaltyObject(ISSUER, { ...CONTENT, program: undefined })).toMatchObject({ loyaltyPoints: { balance: { int: 4 } } });
  });

  it("shows the card's offer first, and announces it with one notifying message named after the campaign (AC 14)", () => {
    const object = googleLoyaltyObject(ISSUER, { ...CONTENT, offer: OFFER });
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

  it("builds an earlier epoch's object INACTIVE, without the QR or stamps (AC 8)", () => {
    const object = googleLoyaltyObject(ISSUER, { ...CONTENT, qr: null, offer: OFFER });
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
