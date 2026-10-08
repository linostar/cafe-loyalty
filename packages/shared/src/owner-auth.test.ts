import { describe, expect, it } from "vitest";
import { linkTokenSchema, loginRequestSchema, ownerEmailSchema, ownerPasswordSchema } from "./owner-auth.js";

describe("ownerEmailSchema", () => {
  it("trims and lower-cases", () => {
    expect(ownerEmailSchema.parse("  Rana@Example.COM ")).toBe("rana@example.com");
  });

  it.each(["", "rana", "rana@", `${"a".repeat(250)}@example.com`])("rejects %s", (value) => {
    expect(ownerEmailSchema.safeParse(value).success).toBe(false);
  });

  it("does not echo the input in its error message", () => {
    const result = ownerEmailSchema.safeParse("not-an-email-xyz");
    expect(JSON.stringify(result.error?.issues)).not.toContain("not-an-email-xyz");
  });
});

describe("ownerPasswordSchema", () => {
  it("accepts 10 to 128 characters of any kind", () => {
    expect(ownerPasswordSchema.safeParse("correct horse").success).toBe(true);
    expect(ownerPasswordSchema.safeParse("كلمة سر طويلة").success).toBe(true);
    expect(ownerPasswordSchema.safeParse("x".repeat(128)).success).toBe(true);
  });

  it("rejects shorter or longer passwords", () => {
    expect(ownerPasswordSchema.safeParse("123456789").success).toBe(false);
    expect(ownerPasswordSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("is not applied at sign-in, so older passwords keep working", () => {
    expect(loginRequestSchema.safeParse({ email: "rana@example.com", password: "short" }).success).toBe(true);
  });
});

describe("linkTokenSchema", () => {
  it("accepts 43 base64url characters only", () => {
    expect(linkTokenSchema.safeParse("A".repeat(42) + "_").success).toBe(true);
    expect(linkTokenSchema.safeParse("A".repeat(42)).success).toBe(false);
    expect(linkTokenSchema.safeParse("A".repeat(42) + "=").success).toBe(false);
  });
});
