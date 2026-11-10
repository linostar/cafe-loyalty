import { describe, expect, it } from "vitest";
import { e164PhoneSchema, normalizePhoneInput, parseCountryCode } from "./phone.js";

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
    ["+44 (0) 7911 123456", "+447911123456"],
    ["96170123456", "+96170123456"],
    ["⁦+961 70 123 456⁩", "+96170123456"],
    ["؜70 123 456", "+96170123456"],
    ["01 123 456", "+9611123456"],
    ["81 123 456", "+96181123456"],
    ["001 415 555 2671", "+14155552671"],
  ])("reads %j as %s", (input, expected) => {
    expect(normalizePhoneInput(input)).toBe(expected);
  });

  it.each([
    "",
    "abc",
    "123",
    "+961 7012345678",
    "+961 12345",
    "70 123 456 789 012",
    "+0 123 4567",
    "12345678",
    "+961 72 123 456",
    "70 123+456",
    "70 123 456 ext 5",
    "+961 70 123 456 x5",
  ])("refuses %j", (input) => {
    expect(normalizePhoneInput(input)).toBeNull();
  });

  it.each([
    // Lebanon's code, as signup's code field starts: today's forms.
    ["70 123 456", "+961", "+96170123456"],
    ["03 123 456", "+961", "+9613123456"],
    ["96170123456", "+961", "+96170123456"],
    // Another country's code: the number joined to it, its trunk 0 dropped.
    ["06 12 34 56 78", "+33", "+33612345678"],
    ["612345678", "+33", "+33612345678"],
    ["(0)20 7946 0958", "+44", "+442079460958"],
    // A number typed with its own code keeps it, whatever the field says.
    ["+33 6 12 34 56 78", "+961", "+33612345678"],
    ["0033 6 12 34 56 78", "+961", "+33612345678"],
    ["+961 70 123 456", "+33", "+96170123456"],
  ])("joins %j to %j as %j", (input, code, expected) => {
    expect(normalizePhoneInput(input, code)).toBe(expected);
  });

  it("still needs a real Lebanese prefix, and refuses what is no number in any country", () => {
    expect(normalizePhoneInput("72 123 456", "+961")).toBeNull();
    expect(normalizePhoneInput("+961 72 123 456", "+33")).toBeNull();
    expect(normalizePhoneInput("123", "+33")).toBeNull();
    expect(normalizePhoneInput("abc", "+33")).toBeNull();
  });
});

describe("parseCountryCode", () => {
  it.each([
    ["+961", "+961"],
    ["00961", "+961"],
    ["961", "+961"],
    ["+1", "+1"],
    [" + 33 ", "+33"],
    ["+٩٦١", "+961"],
  ])("reads %j as %j", (input, expected) => {
    expect(parseCountryCode(input)).toBe(expected);
  });

  it.each(["", "+", "+0", "+1234", "abc", "+96a", "000961"])("refuses %j", (input) => {
    expect(parseCountryCode(input)).toBeNull();
  });
});
