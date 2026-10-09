import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PASS_TEXT, googleClassId, googleLoyaltyClass, googleLoyaltyObject, googleObjectId, signJwt } from "./wallet.js";

const ISSUER = "3388000000012345678";
const CONTENT = {
  cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d",
  cardId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40",
  epoch: 2,
  stamps: 4,
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
  qr: "qr-token",
};

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

  it("builds an earlier epoch's object INACTIVE, without the QR or stamps (AC 8)", () => {
    const object = googleLoyaltyObject(ISSUER, { ...CONTENT, qr: null });
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
