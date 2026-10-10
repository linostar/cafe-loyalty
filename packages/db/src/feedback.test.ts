import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { feedbackUrl, signFeedbackToken, verifyFeedbackToken } from "./feedback.js";

const older = { id: "k1", key: randomBytes(32) };
const newer = { id: "k2", key: randomBytes(32) };
const secrets = { cardQr: { keys: [newer, older] } };
const request = { cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", requestId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40" };

describe("feedback links", () => {
  it("are signed with the newest key and verify back to their café and request (AC 37)", () => {
    const token = signFeedbackToken(secrets, request);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.k2\.[A-Za-z0-9_-]{22}$/);
    expect(verifyFeedbackToken(secrets, token)).toEqual(request);
    expect(feedbackUrl("https://card.example.test", secrets, request)).toBe(`https://card.example.test/f/${token}`);
    // Made with a key since replaced, still listed: still valid.
    expect(verifyFeedbackToken(secrets, signFeedbackToken({ cardQr: { keys: [older] } }, request))).toEqual(request);
  });

  it("refuse a changed request or café, a wrong or unknown key, and anything malformed", () => {
    const token = signFeedbackToken(secrets, request);
    const [cafe = "", requestPart = "", keyId = "", mac = ""] = token.split(".");
    const other = signFeedbackToken(secrets, { ...request, requestId: "7a2d2b63-8d66-4b1f-8b6f-1e5d2c3b4a51" });
    expect(verifyFeedbackToken(secrets, [cafe, other.split(".")[1], keyId, mac].join("."))).toBeNull();
    const otherCafe = signFeedbackToken(secrets, { ...request, cafeId: "1c2b3a49-5e6f-4a7b-9c8d-7e6f5a4b3c2d" });
    expect(verifyFeedbackToken(secrets, [otherCafe.split(".")[0], requestPart, keyId, mac].join("."))).toBeNull();
    expect(verifyFeedbackToken(secrets, [cafe, requestPart, "k1", mac].join("."))).toBeNull();
    expect(verifyFeedbackToken(secrets, [cafe, requestPart, "k9", mac].join("."))).toBeNull();
    expect(verifyFeedbackToken({ cardQr: { keys: [{ id: "k2", key: randomBytes(32) }] } }, token)).toBeNull();
    for (const bad of ["", "abc", `${token}.x`, token.slice(1), token.replace(/.$/, (last) => (last === "A" ? "B" : "A"))]) {
      expect(verifyFeedbackToken(secrets, bad)).toBeNull();
    }
  });
});
