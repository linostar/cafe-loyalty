import { describe, expect, it } from "vitest";
import { isCommonPassword, refuseCommonPassword } from "./common-passwords.js";

describe("isCommonPassword", () => {
  it("finds listed passwords whatever their case or Unicode form", () => {
    expect(isCommonPassword("1234567890")).toBe(true);
    expect(isCommonPassword("QwertyUIOP")).toBe(true);
    // Full-width numerals, as some keyboards type them: NFKC makes them ASCII.
    expect(isCommonPassword("１２３４５６７８９０")).toBe(true);
  });

  it("passes passwords not on the list", () => {
    expect(isCommonPassword("correct horse battery")).toBe(false);
    expect(isCommonPassword("1234567890x")).toBe(false);
  });

  it("refuses as a field issue", () => {
    expect(() => {
      refuseCommonPassword("qwertyuiop", "newPassword");
    }).toThrow(expect.objectContaining({ details: [{ path: "newPassword", issue: "This password is too common. Choose another." }] }));
    expect(() => {
      refuseCommonPassword("correct horse battery", "newPassword");
    }).not.toThrow();
  });
});
