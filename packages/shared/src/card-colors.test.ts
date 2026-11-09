import { describe, expect, it } from "vitest";
import { DEFAULT_CARD_COLORS, MAX_STAMPS_PER_ROW, MIN_CARD_CONTRAST, cardColorsSchema, contrastRatio, stampGrid } from "./card-colors.js";

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

describe("stampGrid", () => {
  it("lays out stamps in the fewest rows of at most 5, spread evenly", () => {
    const grid = (required: number) => {
      const { rows, columns } = stampGrid(required);
      return `${String(rows)}x${String(columns)}`;
    };
    expect([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 50].map(grid)).toEqual(["1x1", "1x4", "1x5", "2x3", "2x4", "2x4", "2x5", "2x5", "3x4", "3x4", "3x5", "4x5", "10x5"]);
    for (let required = 1; required <= 50; required += 1) {
      const { rows, columns } = stampGrid(required);
      expect(columns).toBeLessThanOrEqual(MAX_STAMPS_PER_ROW);
      // Every row holds stamps, and the grid holds them all.
      expect(rows * columns).toBeGreaterThanOrEqual(required);
      expect((rows - 1) * columns).toBeLessThan(required);
    }
  });
});
