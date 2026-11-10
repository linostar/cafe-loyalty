import { createHash, randomBytes } from "node:crypto";
import forge from "node-forge";
import { DEFAULT_CARD_COLORS } from "@cafe-loyalty/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LOGO_TOP_SPACE, applePassToken, buildApplePass, type ApplePassContent } from "./apple-pass.js";
import { testApplePasses, unzipPass } from "./testing/certificates.js";

const apple = testApplePasses();
const secrets = { phoneLookupPepper: randomBytes(32), phoneEncryption: { keys: [] }, cardQr: { keys: [] } };

const content: ApplePassContent = {
  serialNumber: "5f0c6a52-6f2e-4a55-9d2a-8b1f9c3e7d10",
  authenticationToken: applePassToken(secrets, "web-secret"),
  cafeName: "Café Nour",
  colors: { ...DEFAULT_CARD_COLORS },
  stampShape: "circle",
  logo: undefined,
  holderName: null,
  stamps: 4,
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
  qr: "CL1.card-qr-token",
  offers: { optedIn: false, offer: undefined },
  feedbackUrl: undefined,
};

const offer = {
  kind: "campaign" as const,
  campaignId: "2d7e0c1b-5a4f-4e3d-9c2b-1a0f9e8d7c6b",
  nameAr: "عصرية",
  nameEn: "Afternoon",
  discount: { kind: "percent" as const, value: 20 },
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  startsMinute: 14 * 60,
  endsMinute: 16 * 60,
  orderTypes: [{ nameAr: "إسبريسو", nameEn: "Espresso" }],
  announcedAt: new Date("2026-10-05T11:00:00Z"),
  mayNotify: true,
};

function open(pass: Buffer) {
  const files = unzipPass(pass);
  const text = (name: string) => files.get(name)?.toString("utf8") ?? "";
  return { files, text, json: JSON.parse(text("pass.json")) as Record<string, unknown> };
}

describe("buildApplePass", () => {
  it("builds a store card with the card's QR and a strip of its stamps, updated through this server's web service (AC 10, 11)", async () => {
    const { json } = open(await buildApplePass(apple, "https://card.example.test", content));
    expect(json).toMatchObject({
      formatVersion: 1,
      passTypeIdentifier: "pass.example.test",
      teamIdentifier: "TEAMID1234",
      serialNumber: content.serialNumber,
      authenticationToken: content.authenticationToken,
      webServiceURL: "https://card.example.test/passkit",
      organizationName: "Café Nour",
      sharingProhibited: true,
      barcodes: [{ format: "PKBarcodeFormatQR", message: "CL1.card-qr-token", messageEncoding: "iso-8859-1" }],
      storeCard: {
        // No count or "Stamps" label on the front: the strip pictures them; the back says them, without a label.
        primaryFields: [],
        secondaryFields: [{ key: "reward", label: "reward_label", value: "reward_value", textAlignment: "PKTextAlignmentNatural" }],
        auxiliaryFields: [],
        backFields: [
          { key: "stamps", value: "stamps_value" },
          { key: "about", label: "about_label", value: "about_value" },
        ],
      },
    });
    expect(json).not.toHaveProperty("voided");
    // Silent updates: Wallet notifies only of fields with a changeMessage (AC 14).
    expect(JSON.stringify(json)).not.toContain("changeMessage");
  });

  it("shows an opted-in card's offer on its front and details on its back, notifying only on the day it was announced (AC 14)", async () => {
    const { json, text } = open(await buildApplePass(apple, "https://card.example.test", { ...content, offers: { optedIn: true, offer } }));
    expect(json).toMatchObject({
      storeCard: {
        auxiliaryFields: [{ key: "offer", label: "offer_label", value: "offer_value", textAlignment: "PKTextAlignmentNatural", changeMessage: "offer_change" }],
        backFields: [{ key: "stamps" }, { key: "offer_details" }, { key: "about" }],
      },
    });
    const english = text("en.lproj/pass.strings");
    expect(english).toContain('"offer_value" = "Afternoon · 20% off";');
    expect(english).toContain('"offer_change" = "New offer: %@";');
    expect(english).toContain('"offer_details_value" = "Every day, 14:00–16:00, on Espresso.";');
    expect(text("ar.lproj/pass.strings")).toContain('"offer_value" = "عصرية · خصم');
    // Fetched on a later day: the same offer, silently.
    const later = open(await buildApplePass(apple, "https://card.example.test", { ...content, offers: { optedIn: true, offer: { ...offer, mayNotify: false } } })).json;
    expect(JSON.stringify(later)).not.toContain("changeMessage");
  });

  it("shows no offer field on an opted-in card without an offer, so nothing says there is none", async () => {
    const { json, text } = open(await buildApplePass(apple, "https://card.example.test", { ...content, offers: { optedIn: true, offer: undefined } }));
    expect(json).toMatchObject({ storeCard: { auxiliaryFields: [], backFields: [{ key: "stamps" }, { key: "about" }] } });
    expect(JSON.stringify(json)).not.toContain("changeMessage");
    expect(text("en.lproj/pass.strings")).not.toContain("offer_");
    // A voided pass shows no offer.
    const voided = open(await buildApplePass(apple, "https://card.example.test", { ...content, qr: null, offers: { optedIn: true, offer } })).json;
    expect(voided).toMatchObject({ storeCard: { auxiliaryFields: [], backFields: [{ key: "about" }] } });
  });

  it("links to the latest visit's feedback page on its back, silently, the link on a line of its own (AC 37)", async () => {
    const url = "https://card.example.test/f/fake-feedback-token";
    const { json, text } = open(await buildApplePass(apple, "https://card.example.test", { ...content, feedbackUrl: url }));
    expect(json).toMatchObject({ storeCard: { backFields: [{ key: "stamps" }, { key: "feedback", label: "feedback_label", value: "feedback_value" }, { key: "about" }] } });
    expect(JSON.stringify(json)).not.toContain("changeMessage");
    expect(text("en.lproj/pass.strings")).toContain(`"feedback_value" = "Tell the café privately how your visit went.\\n${url}";`);
    expect(text("ar.lproj/pass.strings")).toContain('"feedback_label" = "كيف كانت زيارتك؟";');
    // A voided pass has no link.
    const voided = open(await buildApplePass(apple, "https://card.example.test", { ...content, qr: null, feedbackUrl: url })).json;
    expect(voided).toMatchObject({ storeCard: { backFields: [{ key: "about" }] } });
  });

  it("has every text in Arabic and English (AC 10)", async () => {
    const { text } = open(await buildApplePass(apple, "https://card.example.test", content));
    expect(text("en.lproj/pass.strings")).toContain('"stamps_value" = "4 of 9 stamps";');
    expect(text("en.lproj/pass.strings")).toContain('"reward_value" = "Free coffee";');
    expect(text("en.lproj/pass.strings")).toContain('"description" = "Loyalty card at ⁨Café Nour⁩";');
    expect(text("ar.lproj/pass.strings")).toContain('"stamps_value" = "⁨4⁩ من ⁨9⁩ أختام";');
    expect(text("ar.lproj/pass.strings")).toContain("قهوة مجانية");
    expect(text("en.lproj/pass.strings")).not.toContain("stamps_label");
  });

  it("names the holder in a header field on a card that has one, and builds a nameless card's pass as before", async () => {
    const named = open(await buildApplePass(apple, "https://card.example.test", { ...content, holderName: 'Rania "R" Haddad' }));
    expect(named.json).toMatchObject({ storeCard: { headerFields: [{ key: "holder", value: "holder_value" }] } });
    // In both languages, escaped like every string, so a name is only ever shown as itself.
    expect(named.text("en.lproj/pass.strings")).toContain('"holder_value" = "Rania \\"R\\" Haddad";');
    expect(named.text("ar.lproj/pass.strings")).toContain('"holder_value" = "Rania \\"R\\" Haddad";');
    expect(JSON.stringify(named.json)).not.toContain("changeMessage");
    // No header field (passkit-generator writes the empty list a store card always had).
    const headerFields = (pass: ReturnType<typeof open>) => (pass.json.storeCard as { headerFields?: unknown[] }).headerFields ?? [];
    const nameless = open(await buildApplePass(apple, "https://card.example.test", content));
    expect(headerFields(nameless)).toEqual([]);
    expect(nameless.text("en.lproj/pass.strings")).not.toContain("holder_value");
    // A voided pass (moved) says only that.
    const voided = open(await buildApplePass(apple, "https://card.example.test", { ...content, holderName: "Rania", qr: null }));
    expect(headerFields(voided)).toEqual([]);
    expect(voided.text("en.lproj/pass.strings")).not.toContain("Rania");
  });

  it("escapes quotes and backslashes in the strings files", async () => {
    const { text } = open(await buildApplePass(apple, "https://card.example.test", { ...content, cafeName: 'The "Bean" \\ Co' }));
    expect(text("en.lproj/pass.strings")).toContain('"description" = "Loyalty card at ⁨The \\"Bean\\" \\\\ Co⁩";');
  });

  it("voids the pass of an earlier epoch, without a QR code, saying so in short on its front and in full on its back (AC 8)", async () => {
    const { json, text, files } = open(await buildApplePass(apple, "https://card.example.test", { ...content, qr: null }));
    expect(json).toMatchObject({ voided: true, storeCard: { primaryFields: [{ key: "moved", label: "moved_label", value: "moved_value" }], secondaryFields: [], backFields: [{ key: "about" }] } });
    expect(json).not.toHaveProperty("barcodes");
    expect(files.has("strip.png")).toBe(false);
    const english = text("en.lproj/pass.strings");
    expect(english).toContain('"moved_value" = "Use your new card";');
    expect(english).toContain('"about_value" = "This card was restored on another phone. Use the card there.";');
    expect(english).not.toContain("collect stamps");
    expect(text("ar.lproj/pass.strings")).toContain('"moved_value" = "استخدم بطاقتك الجديدة";');
  });

  it("pictures the stamps on a strip at Apple's three sizes, and none without a program", async () => {
    const { files } = open(await buildApplePass(apple, "https://card.example.test", { ...content, stampShape: "bean" }));
    const sizes = await Promise.all(["strip.png", "strip@2x.png", "strip@3x.png"].map(async (name) => sharp(files.get(name)).metadata()));
    expect(sizes.map(({ width, height }) => [width, height])).toEqual([
      [375, 123],
      [750, 246],
      [1125, 369],
    ]);
    const without = open(await buildApplePass(apple, "https://card.example.test", { ...content, program: undefined }));
    expect(without.files.has("strip.png")).toBe(false);
    expect(without.json).toMatchObject({ storeCard: { primaryFields: [], backFields: [{ key: "about" }] } });
  });

  it("takes the café's colours, icons of its background and its logo at three sizes, with space above it and no change message", async () => {
    const image = (scale: number) => sharp({ create: { width: 160 * scale, height: 40 * scale, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } }).png().toBuffer();
    const logo = { apple1x: await image(1), apple2x: await image(2), apple3x: await image(3) };
    const { json, files } = open(await buildApplePass(apple, "https://card.example.test", { ...content, colors: { background: "#1f5a85", foreground: "#ffffff", label: "#e5eff7" }, logo }));
    expect(json).toMatchObject({ backgroundColor: "rgb(31, 90, 133)", foregroundColor: "rgb(255, 255, 255)", labelColor: "rgb(229, 239, 247)", logoText: "Café Nour" });
    // The logo as given, under LOGO_TOP_SPACE points of transparency at each scale.
    for (const [scale, name] of [[1, "logo.png"], [2, "logo@2x.png"], [3, "logo@3x.png"]] as const) {
      const { data, info } = await sharp(files.get(name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height], name).toEqual([160 * scale, (40 + LOGO_TOP_SPACE) * scale]);
      // Alpha of the top-left pixel (transparent space) and of the first pixel of the logo.
      expect(data[3], name).toBe(0);
      expect(data[(LOGO_TOP_SPACE * scale * info.width) * 4 + 3], name).toBe(255);
    }
    expect(JSON.stringify(json)).not.toContain("changeMessage");
    const defaults = open(await buildApplePass(apple, "https://card.example.test", content));
    expect(defaults.json).toMatchObject({ backgroundColor: "rgb(74, 44, 42)", foregroundColor: "rgb(255, 255, 255)", labelColor: "rgb(235, 214, 190)" });
    expect(defaults.files.has("logo.png")).toBe(false);
    expect(files.get("icon.png")).not.toEqual(defaults.files.get("icon.png"));
  });

  it("lists every file in the manifest by its SHA-1 and signs the manifest with the pass type certificate", async () => {
    const { files, text } = open(await buildApplePass(apple, "https://card.example.test", content));
    const manifest = JSON.parse(text("manifest.json")) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(
      ["ar.lproj/pass.strings", "en.lproj/pass.strings", "icon.png", "icon@2x.png", "icon@3x.png", "pass.json", "strip.png", "strip@2x.png", "strip@3x.png"].sort(),
    );
    for (const [name, digest] of Object.entries(manifest)) {
      expect(createHash("sha1").update(files.get(name) ?? Buffer.alloc(0)).digest("hex"), name).toBe(digest);
    }
    const signature = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(files.get("signature")?.toString("binary") ?? "")) as forge.pkcs7.PkcsSignedData;
    expect(signature.certificates.map((certificate) => (certificate.subject.getField("CN") as { value: unknown } | null)?.value)).toEqual(
      expect.arrayContaining(["Pass Type ID: pass.example.test", "Test WWDR"]),
    );
  });
});

describe("applePassToken", () => {
  it("gives a 256-bit token per web secret, the same each time (AC 11)", () => {
    expect(applePassToken(secrets, "web-secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(applePassToken(secrets, "web-secret")).toBe(applePassToken(secrets, "web-secret"));
    expect(applePassToken(secrets, "other-secret")).not.toBe(applePassToken(secrets, "web-secret"));
  });
});
