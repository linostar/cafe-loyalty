import { describe, expect, it } from "vitest";
import { e164PhoneSchema } from "./phone.js";

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
