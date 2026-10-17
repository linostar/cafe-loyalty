import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMAIL_UNDO_TTL_SECONDS, signEmailUndoToken, verifyEmailUndoToken } from "./email-undo.js";

const older = { id: "k1", key: randomBytes(32) };
const newer = { id: "k2", key: randomBytes(32) };
const secrets = { cardQr: { keys: [newer, older] } };
const lookup = randomBytes(32);
const card = { cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", cardId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40", emailLookup: lookup };
const now = Date.UTC(2026, 9, 17, 12);

describe("email undo links", () => {
  it("verify back to their café and card for 7 days, and match only the old email's lookup", () => {
    const token = signEmailUndoToken(secrets, card, now);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[A-Za-z0-9_-]{11}\.k2\.[A-Za-z0-9_-]{16}$/);
    expect(signEmailUndoToken({ cardQr: { keys: [{ id: "k".repeat(16), key: older.key }] } }, card, now).length).toBeLessThanOrEqual(100);
    // No personal data and no raw lookup in it.
    expect(token).not.toContain(lookup.toString("base64url").slice(0, 22));
    const verified = verifyEmailUndoToken(secrets, token, now);
    expect(verified).toMatchObject({ cafeId: card.cafeId, cardId: card.cardId });
    expect(verified?.isFor(lookup)).toBe(true);
    expect(verified?.isFor(randomBytes(32))).toBe(false);
    expect(verifyEmailUndoToken(secrets, token, now + EMAIL_UNDO_TTL_SECONDS * 1000 - 1000)).not.toBeNull();
    expect(verifyEmailUndoToken(secrets, token, now + EMAIL_UNDO_TTL_SECONDS * 1000)).toBeNull();
    // Made with a key since replaced, still listed: still valid.
    expect(verifyEmailUndoToken(secrets, signEmailUndoToken({ cardQr: { keys: [older] } }, card, now), now)?.isFor(lookup)).toBe(true);
  });

  it("refuse a changed card, café, expiry or binding, a wrong or unknown key, and anything malformed", () => {
    const token = signEmailUndoToken(secrets, card, now);
    const [cafe = "", cardPart = "", expires = "", binding = "", keyId = "", mac = ""] = token.split(".");
    const other = signEmailUndoToken(secrets, { ...card, cardId: "7a2d2b63-8d66-4b1f-8b6f-1e5d2c3b4a51", emailLookup: randomBytes(32) }, now).split(".");
    const tampered = [
      [cafe, other[1], expires, binding, keyId, mac],
      [cafe, cardPart, (parseInt(expires, 36) + 1).toString(36), binding, keyId, mac],
      [cafe, cardPart, expires, other[3], keyId, mac],
      [cafe, cardPart, expires, binding, "k1", mac],
      [cafe, cardPart, expires, binding, "k9", mac],
    ];
    for (const parts of tampered) {
      expect(verifyEmailUndoToken(secrets, parts.join("."), now)).toBeNull();
    }
    expect(verifyEmailUndoToken({ cardQr: { keys: [{ id: "k2", key: randomBytes(32) }] } }, token, now)).toBeNull();
    for (const bad of ["", "abc", `${token}.x`, token.slice(1), token.replace(/.$/, (last) => (last === "A" ? "B" : "A"))]) {
      expect(verifyEmailUndoToken(secrets, bad, now)).toBeNull();
    }
  });
});
