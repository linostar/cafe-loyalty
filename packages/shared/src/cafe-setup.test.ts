import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_ALPHABET,
  deviceCatalogSchema,
  devicePairProofPayload,
  deviceTokenSigningPayload,
  formatPairingCode,
  normalizePairingCode,
  orderTypeUpdateSchema,
  pairRequestSchema,
  staffPinSchema,
  winBackSettingsSchema,
} from "./cafe-setup.js";

describe("staffPinSchema", () => {
  it.each(["482913", "205871", "000123", "9081726354"])("accepts %s", (pin) => {
    expect(staffPinSchema.safeParse(pin).success).toBe(true);
  });

  it.each(["12345", "1234567890123", "12a456", " 482913", "111111", "123456", "987654", "890123", "000000"])("refuses %s", (pin) => {
    expect(staffPinSchema.safeParse(pin).success).toBe(false);
  });

  it("gives one message per problem", () => {
    expect(staffPinSchema.safeParse("12345").error?.issues.map((issue) => issue.message)).toEqual(["Use 6 to 12 digits."]);
    expect(staffPinSchema.safeParse("123456").error?.issues).toHaveLength(1);
  });

  it("does not echo the PIN in its message", () => {
    expect(JSON.stringify(staffPinSchema.safeParse("876543").error?.issues)).not.toContain("876543");
  });
});

describe("pairing codes", () => {
  it("use a 32-character alphabet without I, L, O or U", () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32);
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it("normalise what people type", () => {
    expect(normalizePairingCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizePairingCode(" ABCD EFGH JKMN ")).toBe("ABCDEFGHJKMN");
    expect(normalizePairingCode("OIL0-EFGH-JKMN")).toBe("0110EFGHJKMN");
  });

  it("refuse the wrong length or letters outside the alphabet", () => {
    expect(normalizePairingCode("ABCD-EFGH-JKM")).toBeNull();
    expect(normalizePairingCode("ABCD-EFGH-JKMU")).toBeNull();
    expect(pairRequestSchema.safeParse({ code: "nope", publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) } }).success).toBe(false);
  });

  it("are shown in groups of four", () => {
    expect(formatPairingCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
  });
});

describe("deviceTokenSigningPayload", () => {
  it("is domain-separated and lower-cases the ids", () => {
    expect(
      deviceTokenSigningPayload({
        deviceId: "0B9A3C4D-1E2F-4A5B-8C7D-6E5F4A3B2C1D",
        keyId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40",
        issuedAt: "2026-10-08T12:00:00.000Z",
      }),
    ).toBe("cafe-loyalty/device-token/v1\n0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d\n6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40\n2026-10-08T12:00:00.000Z");
  });
});

describe("devicePairProofPayload", () => {
  it("is domain-separated from token renewals and bound to the code and the new key", () => {
    const previous = { deviceId: "0B9A3C4D-1E2F-4A5B-8C7D-6E5F4A3B2C1D", keyId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40" };
    const key = { kty: "EC" as const, crv: "P-256" as const, x: "X".repeat(43), y: "Y".repeat(43) };
    expect(devicePairProofPayload("ABCD1234EFGH", previous, key)).toBe(
      `cafe-loyalty/device-pair-proof/v1\nABCD1234EFGH\n0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d\n6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40\n${"X".repeat(43)}\n${"Y".repeat(43)}`,
    );
    expect(devicePairProofPayload("ABCD1234EFGH", previous, { ...key, y: "Z".repeat(43) })).not.toBe(devicePairProofPayload("ABCD1234EFGH", previous, key));
    expect(devicePairProofPayload("ABCD1234EFGJ", previous, key)).not.toBe(devicePairProofPayload("ABCD1234EFGH", previous, key));
  });

  it("travels as an optional previous device in the pairing request", () => {
    const publicKey = { kty: "EC", crv: "P-256", x: "X".repeat(43), y: "Y".repeat(43) };
    const previous = { deviceId: "0B9A3C4D-1E2F-4A5B-8C7D-6E5F4A3B2C1D", keyId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40", signature: "A".repeat(86) };
    expect(pairRequestSchema.parse({ code: "ABCD-1234-EFGH", publicKey, previous }).previous?.deviceId).toBe("0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d");
    expect(pairRequestSchema.safeParse({ code: "ABCD-1234-EFGH", publicKey, previous: { ...previous, signature: "short" } }).success).toBe(false);
  });
});

describe("orderTypeUpdateSchema", () => {
  it("needs at least one field", () => {
    expect(orderTypeUpdateSchema.safeParse({}).success).toBe(false);
    expect(orderTypeUpdateSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe("device catalog", () => {
  it("reads a catalog from a server before campaigns and win-back as one with neither (a rollback)", () => {
    expect(deviceCatalogSchema.parse({ catalogVersion: 3, orderTypes: [], program: null })).toEqual({
      catalogVersion: 3,
      timeZone: "UTC",
      campaigns: [],
      winBack: null,
      orderTypes: [],
      program: null,
    });
  });
});

describe("win-back settings (AC 36)", () => {
  it("takes a discount or none, and a cool-down from the 14 days an offer lasts to a year", () => {
    expect(winBackSettingsSchema.safeParse({ discount: { kind: "percent", value: 15 }, cooldownDays: 30 }).success).toBe(true);
    expect(winBackSettingsSchema.safeParse({ discount: null, cooldownDays: 14 }).success).toBe(true);
    expect(winBackSettingsSchema.safeParse({ discount: { kind: "amount", value: 50 }, cooldownDays: 365 }).success).toBe(true);
    for (const wrong of [
      { discount: null, cooldownDays: 13 },
      { discount: null, cooldownDays: 366 },
      { discount: { kind: "percent", value: 101 }, cooldownDays: 30 },
      { discount: { kind: "amount", value: 0 }, cooldownDays: 30 },
      { cooldownDays: 30 },
    ]) {
      expect(winBackSettingsSchema.safeParse(wrong).success).toBe(false);
    }
  });
});
