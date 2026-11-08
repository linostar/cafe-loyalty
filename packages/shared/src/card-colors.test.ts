import { describe, expect, it } from "vitest";
import { DEFAULT_CARD_COLORS, MIN_CARD_CONTRAST, cardColorsSchema, contrastRatio } from "./card-colors.js";

describe("card colours", () => {
  it("computes WCAG contrast either way round", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    // A known pair: #767676 is the lightest grey with 4.5:1 on white.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("accepts the default colours, which every existing card has", () => {
    expect(contrastRatio(DEFAULT_CARD_COLORS.foreground, DEFAULT_CARD_COLORS.background)).toBeGreaterThanOrEqual(MIN_CARD_CONTRAST);
    expect(contrastRatio(DEFAULT_CARD_COLORS.label, DEFAULT_CARD_COLORS.background)).toBeGreaterThanOrEqual(MIN_CARD_CONTRAST);
    expect(cardColorsSchema.parse(DEFAULT_CARD_COLORS)).toEqual(DEFAULT_CARD_COLORS);
  });

  it("keeps colours lowercase whatever case they come in", () => {
    expect(cardColorsSchema.parse({ background: "#1F5A85", foreground: "#FFFFFF", label: "#E5EFF7" })).toEqual({ background: "#1f5a85", foreground: "#ffffff", label: "#e5eff7" });
  });

  it("refuses a colour that is not #rrggbb, on its own field", () => {
    const result = cardColorsSchema.safeParse({ background: "red", foreground: "#fff", label: "#ffffff" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["background", "foreground"]);
  });

  it("refuses text or labels below 4.5:1 against the background, each on its field", () => {
    const result = cardColorsSchema.safeParse({ background: "#ffffff", foreground: "#777777", label: "#eeeeee" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["foreground", "Pick a text colour that stands out more from the background: at least 4.5 to 1."],
      ["label", "Pick a label colour that stands out more from the background: at least 4.5 to 1."],
    ]);
  });
});
