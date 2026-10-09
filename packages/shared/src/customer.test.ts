import { describe, expect, it } from "vitest";
import { cardQrSigningPayload, formatCardQr, parseCardQr } from "./customer.js";

const fields = { cardId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40", cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", epoch: 3, keyId: "q1" };
const mac = "A".repeat(43);

describe("card QR tokens", () => {
  it("round-trip through format and parse", () => {
    const token = formatCardQr(fields, mac);
    expect(token).toBe(`v1.${fields.cardId}.${fields.cafeId}.3.q1.${mac}`);
    expect(parseCardQr(token)).toEqual({ ...fields, mac });
  });

  it("sign card, café, epoch and key, domain-separated", () => {
    expect(cardQrSigningPayload(fields)).toBe(`cafe-loyalty/card-qr/v1\n${fields.cardId}\n${fields.cafeId}\n3\nq1`);
  });

  it.each([
    "",
    `v2.${fields.cardId}.${fields.cafeId}.3.q1.${mac}`,
    `v1.${fields.cardId}.${fields.cafeId}.0.q1.${mac}`,
    `v1.${fields.cardId.toUpperCase()}.${fields.cafeId}.3.q1.${mac}`,
    `v1.${fields.cardId}.${fields.cafeId}.3.Q1.${mac}`,
    `v1.${fields.cardId}.${fields.cafeId}.3.q1.${mac}x`,
  ])("refuse %j", (token) => {
    expect(parseCardQr(token)).toBeNull();
  });
});
