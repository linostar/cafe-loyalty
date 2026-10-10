import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOGO_SVG_PATH, selfHostedFonts, stylesheets, tokenValue } from "./index.js";

describe("selfHostedFonts", () => {
  it("serves every face of fonts.css from the prefix, each with its unicode range and a swap display", () => {
    const { css, files } = selfHostedFonts("/assets/fonts/");
    const faces = css.split("@font-face").slice(1);
    // Three weights, each in several subsets.
    expect(faces.length).toBeGreaterThanOrEqual(6);
    for (const face of faces) {
      expect(face).toContain("font-family: 'IBM Plex Sans Arabic'");
      expect(face).toContain("font-display: swap");
      expect(face).toMatch(/unicode-range: U\+/);
    }
    expect(css).not.toContain("./files/");
    for (const weight of [400, 600, 700]) {
      for (const subset of ["arabic", "latin"]) {
        const file = `ibm-plex-sans-arabic-${subset}-${String(weight)}-normal.woff2`;
        expect(css).toContain(`url(/assets/fonts/${file})`);
        expect(existsSync(files.get(file) ?? "")).toBe(true);
      }
    }
  });
});

describe("stylesheets", () => {
  it("joins the named stylesheets in order, without their comments", () => {
    const css = stylesheets(["tokens", "base"]);
    expect(css.indexOf("--color-page")).toBeGreaterThanOrEqual(0);
    expect(css.indexOf("--color-page")).toBeLessThan(css.indexOf(".card {"));
    expect(css).not.toContain("/*");
    // The apps' own components (app.css) are not part of the base.
    expect(css).not.toContain(".topbar");
  });
});

describe("tokenValue", () => {
  it("reads a token from tokens.css, and refuses one that does not exist", () => {
    expect(tokenValue("color-espresso")).toMatch(/^#[0-9a-f]{6}$/);
    expect(tokenValue("radius-pill")).toBe("999px");
    expect(() => tokenValue("color-nothing")).toThrow("--color-nothing");
  });
});

describe("LOGO_SVG_PATH", () => {
  it("is the logo's SVG", () => {
    expect(readFileSync(LOGO_SVG_PATH, "utf8")).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  });
});
