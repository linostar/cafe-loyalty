import { describe, expect, it } from "vitest";
import { MAX_HOLDER_NAME, parseHolderName } from "./holder-name.js";

describe("parseHolderName", () => {
  it.each([
    ["Rania", "Rania"],
    ["  Rania   Haddad  ", "Rania Haddad"],
    ["رانيا حداد", "رانيا حداد"],
    // Decomposed é becomes the one precomposed character.
    ["René", "René"],
    // Direction marks and zero-width characters are dropped.
    ["‮Rania‏", "Rania"],
    ["x".repeat(MAX_HOLDER_NAME), "x".repeat(MAX_HOLDER_NAME)],
  ])("reads %j as %j", (input, expected) => {
    expect(parseHolderName(input)).toBe(expected);
  });

  it.each(["", "   ", "‏", "x".repeat(MAX_HOLDER_NAME + 1), "Ra\u0000nia", "Ra\u0007nia"])("refuses %j", (input) => {
    expect(parseHolderName(input)).toBeNull();
  });

  it("counts characters, not UTF-16 units, as the database does", () => {
    expect(parseHolderName("😀".repeat(MAX_HOLDER_NAME))).toBe("😀".repeat(MAX_HOLDER_NAME));
  });
});
