import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_ALPHABET,
  deviceTokenSigningPayload,
  formatPairingCode,
  normalizePairingCode,
  orderTypeUpdateSchema,
  pairRequestSchema,
  staffPinSchema,
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

describe("orderTypeUpdateSchema", () => {
  it("needs at least one field", () => {
    expect(orderTypeUpdateSchema.safeParse({}).success).toBe(false);
    expect(orderTypeUpdateSchema.safeParse({ active: false }).success).toBe(true);
  });
});
