import { describe, expect, it } from "vitest";
import { centsToInput, parseUsdInput, parseWholeNumberInput } from "./money-input.js";

describe("parseUsdInput", () => {
  it.each([
    ["2", 200],
    ["2.5", 250],
    ["2.50", 250],
    [" $2.05 ", 205],
    ["0", 0],
    ["1000000", 100_000_000],
    ["٢٫٥٠", 250],
    ["۳.۰۵", 305],
    ["1,500", 150_000],
    ["$1,000,000", 100_000_000],
    ["1,234.50", 123_450],
    ["١٬٥٠٠", 150_000],
  ])("reads %j as %i cents", (input, cents) => {
    expect(parseUsdInput(input)).toBe(cents);
  });

  it.each(["", "abc", "2.505", "-1", "2,50", "1,50", "1,5000", "15,00", "10000000", "1000000.01", "1,000,000.01", "0,500", "00,500", "0٬500"])("refuses %j", (input) => {
    expect(parseUsdInput(input)).toBeNull();
  });
});

describe("centsToInput", () => {
  it("shows two decimals", () => {
    expect(centsToInput(250)).toBe("2.50");
    expect(centsToInput(5)).toBe("0.05");
  });
});

describe("parseWholeNumberInput", () => {
  it("reads whole numbers", () => {
    expect(parseWholeNumberInput(" 12 ")).toBe(12);
    expect(parseWholeNumberInput("0")).toBe(0);
    expect(parseWholeNumberInput("١٢")).toBe(12);
  });

  it.each(["", " ", "1.5", "-2", "nine", "1e3"])("refuses %j", (input) => {
    expect(parseWholeNumberInput(input)).toBeNull();
  });
});
