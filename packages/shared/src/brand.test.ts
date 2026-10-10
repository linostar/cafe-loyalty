import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "./brand.js";

describe("PRODUCT_NAME", () => {
  // The headings and the reset email take the name from here; this pins the name that ships.
  it("is the working product name", () => {
    expect(PRODUCT_NAME).toBe("Qahwa Loyalty");
  });
});
