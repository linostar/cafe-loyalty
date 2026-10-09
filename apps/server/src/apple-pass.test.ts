import { createHash, randomBytes } from "node:crypto";
import forge from "node-forge";
import { describe, expect, it } from "vitest";
import { applePassToken, buildApplePass, type ApplePassContent } from "./apple-pass.js";
import { testApplePasses, unzipPass } from "./testing/certificates.js";

const apple = testApplePasses();
const secrets = { phoneLookupPepper: randomBytes(32), phoneEncryption: { keys: [] }, cardQr: { keys: [] } };

const content: ApplePassContent = {
  serialNumber: "5f0c6a52-6f2e-4a55-9d2a-8b1f9c3e7d10",
  authenticationToken: applePassToken(secrets, "web-secret"),
  cafeName: "Café Nour",
  stamps: 4,
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
  qr: "CL1.card-qr-token",
};

function open(pass: Buffer) {
  const files = unzipPass(pass);
  const text = (name: string) => files.get(name)?.toString("utf8") ?? "";
  return { files, text, json: JSON.parse(text("pass.json")) as Record<string, unknown> };
}

describe("buildApplePass", () => {
  it("builds a store card with the card's QR and stamps, updated through this server's web service (AC 10, 11)", () => {
    const { json } = open(buildApplePass(apple, "https://card.example.test", content));
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
        primaryFields: [{ key: "stamps", label: "stamps_label", value: "stamps_value" }],
        secondaryFields: [{ key: "reward", label: "reward_label", value: "reward_value" }],
        backFields: [{ key: "about", label: "about_label", value: "about_value" }],
      },
    });
    expect(json).not.toHaveProperty("voided");
    // Silent updates: Wallet notifies only of fields with a changeMessage (AC 14).
    expect(JSON.stringify(json)).not.toContain("changeMessage");
  });

  it("has every text in Arabic and English (AC 10)", () => {
    const { text } = open(buildApplePass(apple, "https://card.example.test", content));
    expect(text("en.lproj/pass.strings")).toContain('"stamps_value" = "⁨4⁩ of ⁨9 stamps⁩";');
    expect(text("en.lproj/pass.strings")).toContain('"reward_value" = "Collect ⁨9⁩ stamps and get: ⁨Free coffee⁩.";');
    expect(text("en.lproj/pass.strings")).toContain('"description" = "Loyalty card at ⁨Café Nour⁩";');
    expect(text("ar.lproj/pass.strings")).toContain('"stamps_label" = "الأختام";');
    expect(text("ar.lproj/pass.strings")).toContain("قهوة مجانية");
  });

  it("escapes quotes and backslashes in the strings files", () => {
    const { text } = open(buildApplePass(apple, "https://card.example.test", { ...content, cafeName: 'The "Bean" \\ Co' }));
    expect(text("en.lproj/pass.strings")).toContain('"description" = "Loyalty card at ⁨The \\"Bean\\" \\\\ Co⁩";');
  });

  it("voids the pass of an earlier epoch, without a QR code (AC 8)", () => {
    const { json, text } = open(buildApplePass(apple, "https://card.example.test", { ...content, qr: null }));
    expect(json).toMatchObject({ voided: true, storeCard: { secondaryFields: [] } });
    expect(json).not.toHaveProperty("barcodes");
    expect(text("en.lproj/pass.strings")).toContain('"stamps_value" = "This card was restored on another phone. Use the card there.";');
  });

  it("lists every file in the manifest by its SHA-1 and signs the manifest with the pass type certificate", () => {
    const { files, text } = open(buildApplePass(apple, "https://card.example.test", content));
    const manifest = JSON.parse(text("manifest.json")) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(
      ["ar.lproj/pass.strings", "en.lproj/pass.strings", "icon.png", "icon@2x.png", "icon@3x.png", "pass.json"].sort(),
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
