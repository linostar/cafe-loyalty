import { describe, expect, it } from "vitest";
import {
  OPERATOR_SESSION_COOKIE,
  SESSION_COOKIE,
  clearedOperatorCookie,
  clearedSessionCookie,
  hashPassword,
  hashToken,
  newToken,
  operatorSessionCookie,
  readOperatorCookie,
  readSessionCookie,
  sessionCookie,
  verifyPassword,
} from "./credentials.js";

describe("tokens", () => {
  it("are 256-bit base64url strings, different every time", () => {
    const first = newToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(newToken()).not.toBe(first);
  });

  it("are stored as a 32-byte SHA-256 hash", () => {
    const token = newToken();
    expect(hashToken(token)).toHaveLength(32);
    expect(hashToken(token).equals(hashToken(token))).toBe(true);
  });
});

describe("session cookie", () => {
  it("is host-only, HttpOnly, Secure and SameSite=Strict", () => {
    const token = newToken();
    expect(sessionCookie(token, 60)).toBe(`__Host-cl_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60`);
    expect(clearedSessionCookie).toBe("__Host-cl_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  });

  it("is read from among other cookies", () => {
    const token = newToken();
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE}=${token}; lang=ar`)).toBe(token);
  });

  it("is ignored when missing or not shaped like a token", () => {
    expect(readSessionCookie(undefined)).toBeUndefined();
    expect(readSessionCookie("theme=dark")).toBeUndefined();
    expect(readSessionCookie(`${SESSION_COOKIE}=short`)).toBeUndefined();
    expect(readSessionCookie(`${SESSION_COOKIE}=${"a".repeat(42)};`)).toBeUndefined();
  });

  it("keeps the operator's session apart from the owner's (AC 39)", () => {
    const owner = newToken();
    const operator = newToken();
    const header = `${SESSION_COOKIE}=${owner}; ${OPERATOR_SESSION_COOKIE}=${operator}`;
    expect(readSessionCookie(header)).toBe(owner);
    expect(readOperatorCookie(header)).toBe(operator);
    expect(readOperatorCookie(`${SESSION_COOKIE}=${owner}`)).toBeUndefined();
    expect(operatorSessionCookie(operator, 60)).toBe(`__Host-cl_operator=${operator}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60`);
    expect(clearedOperatorCookie).toBe("__Host-cl_operator=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  });
});

describe("passwords", () => {
  it("are hashed with argon2id at OWASP's minimum cost and verified", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(stored).not.toContain("correct horse battery");
    expect(await verifyPassword(stored, "correct horse battery")).toBe(true);
    expect(await verifyPassword(stored, "wrong horse battery")).toBe(false);
  });

  it("fail without a stored hash", async () => {
    expect(await verifyPassword(undefined, "anything at all")).toBe(false);
  });
});
