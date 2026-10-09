import { describe, expect, it } from "vitest";
import { e164PhoneSchema, normalizePhoneInput } from "./phone.js";

describe("e164PhoneSchema", () => {
  it.each(["+96170123456", "+9613123456", "+14155552671", "+447911123456"])("accepts %s", (value) => {
    expect(e164PhoneSchema.safeParse(value).success).toBe(true);
  });

  it.each(["96170123456", "+0961701234", "+961 70 123 456", "+961-70123456", "+12345", "+1234567890123456", "", "070123456"])(
    "rejects %s",
    (value) => {
      expect(e164PhoneSchema.safeParse(value).success).toBe(false);
    },
  );

  it("does not echo the input in its error message", () => {
    const result = e164PhoneSchema.safeParse("+961 70 123 456");
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain("70 123 456");
  });
});

describe("normalizePhoneInput", () => {
  it.each([
    ["70 123 456", "+96170123456"],
    ["070-123-456", "+96170123456"],
    ["03 123 456", "+9613123456"],
    ["06 123456", "+9616123456"],
    ["+961 70 123 456", "+96170123456"],
    ["+961 03 123 456", "+9613123456"],
    ["0096170123456", "+96170123456"],
    ["٧٠١٢٣٤٥٦", "+96170123456"],
    ["٠٣ ١٢٣ ٤٥٦", "+9613123456"],
    ["۷۰۱۲۳۴۵۶", "+96170123456"],
    ["‎+961 (70) 123.456", "+96170123456"],
    ["+44 7911 123456", "+447911123456"],
    ["001 415 555 2671", "+14155552671"],
  ])("reads %j as %s", (input, expected) => {
    expect(normalizePhoneInput(input)).toBe(expected);
  });

  it.each(["", "abc", "123", "+961 7012345678", "+961 12345", "70 123 456 789 012", "+0 123 4567"])("refuses %j", (input) => {
    expect(normalizePhoneInput(input)).toBeNull();
  });
});
