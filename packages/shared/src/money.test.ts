import { describe, expect, it } from "vitest";
import { MAX_CENTS, centsSchema, formatUsd } from "./money.js";

describe("centsSchema", () => {
  it.each([0, 1, 350, MAX_CENTS])("accepts %s", (value) => {
    expect(centsSchema.safeParse(value).success).toBe(true);
  });

  it.each([-1, 3.5, MAX_CENTS + 1, Number.NaN, Number.POSITIVE_INFINITY, "350"])("rejects %s", (value) => {
    expect(centsSchema.safeParse(value).success).toBe(false);
  });
});

describe("formatUsd", () => {
  it("formats in English", () => {
    expect(formatUsd(350, "en")).toBe("$3.50");
    expect(formatUsd(0, "en")).toBe("$0.00");
  });

  it("formats in Arabic with the dollar amount", () => {
    const text = formatUsd(350, "ar");
    expect(text).toMatch(/US\$|\$|دولار/u);
    expect(text.replace(/[^\d٠-٩]/gu, "")).toMatch(/^(350|٣٥٠)$/u);
  });
});
