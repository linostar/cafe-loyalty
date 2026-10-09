import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPhone, emailLookup, encryptPhone, phoneLookup, signCardQr, verifyCardQr, type CustomerSecrets } from "./customer-crypto.js";

const secrets = (): CustomerSecrets => ({
  phoneLookupPepper: randomBytes(32),
  phoneEncryption: { keys: [{ id: "p2", key: randomBytes(32) }, { id: "p1", key: randomBytes(32) }] },
  cardQr: { keys: [{ id: "q2", key: randomBytes(32) }, { id: "q1", key: randomBytes(32) }] },
});
const card = { cardId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40", cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", epoch: 2 };

describe("lookups", () => {
  it("are stable per pepper and keep phones and emails apart", () => {
    const s = secrets();
    expect(phoneLookup(s, "+96170123456").equals(phoneLookup(s, "+96170123456"))).toBe(true);
    expect(phoneLookup(s, "+96170123456").equals(phoneLookup(secrets(), "+96170123456"))).toBe(false);
    expect(phoneLookup(s, "x").equals(emailLookup(s, "x"))).toBe(false);
  });
});

describe("phone encryption", () => {
  it("round-trips with the newest key and a fresh IV each time", () => {
    const s = secrets();
    const first = encryptPhone(s, "+96170123456");
    const second = encryptPhone(s, "+96170123456");
    expect(first.keyId).toBe("p2");
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(decryptPhone(s, first.keyId, first.ciphertext)).toBe("+96170123456");
  });

  it("refuses altered data and unknown keys", () => {
    const s = secrets();
    const { keyId, ciphertext } = encryptPhone(s, "+96170123456");
    const altered = Buffer.from(ciphertext);
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
    expect(() => decryptPhone(s, keyId, altered)).toThrow();
    expect(() => decryptPhone(s, "p9", ciphertext)).toThrow("No phone encryption key has id p9.");
  });
});

describe("card QR codes", () => {
  it("verify when signed with any listed key, and sign with the newest", () => {
    const s = secrets();
    const token = signCardQr(s, card);
    expect(token).toContain(".q2.");
    expect(verifyCardQr(s, token)).toEqual(card);
    const older = signCardQr({ ...s, cardQr: { keys: [s.cardQr.keys[1] ?? { id: "", key: Buffer.alloc(0) }] } }, card);
    expect(verifyCardQr(s, older)).toEqual(card);
  });

  it("accept exactly one spelling of the signature", () => {
    const s = secrets();
    const token = signCardQr(s, card);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const accepted = Array.from(alphabet).filter((last) => verifyCardQr(s, `${token.slice(0, -1)}${last}`) !== null);
    expect(accepted).toEqual([token.slice(-1)]);
  });

  it("refuse any change to the card, café, epoch, key or signature", () => {
    const s = secrets();
    const token = signCardQr(s, card);
    for (const forged of [
      token.replace(card.cardId, "7f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40"),
      token.replace(card.cafeId, "1b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d"),
      token.replace(".2.q2.", ".3.q2."),
      token.replace(".q2.", ".q1."),
      // A middle character of the mac.
      `${token.slice(0, -20)}${token.at(-20) === "A" ? "B" : "A"}${token.slice(-19)}`,
      signCardQr(secrets(), card),
    ]) {
      expect(verifyCardQr(s, forged)).toBeNull();
    }
  });
});
