import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

/** Every stylesheet of the front ends: this package's (the customer pages use them too) and each web app's. */
const STYLESHEETS = ["packages/ui/src", "apps/dashboard/src", "apps/counter/src"].flatMap((dir) =>
  readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".css"))
    .map((file) => join(dir, file)),
);

/**
 * Properties tied to a physical side or axis, which a right-to-left page would need to flip: each has a logical one
 * (margin-inline-start, inset-block-start, text-align: start, inline-size and so on).
 */
const PHYSICAL = [
  /\b(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right|top|bottom)\b/,
  /\bborder-(?:top|bottom)-(?:left|right)-radius\b/,
  /(?:^|[\s;{])(?:left|right|top|bottom)\s*:/,
  /(?:^|[\s;{])(?:min-|max-)?(?:width|height)\s*:/,
  /\btext-align\s*:\s*(?:left|right)\b/,
  /\b(?:float|clear)\s*:\s*(?:left|right)\b/,
  // Four values set the four physical sides (or corners) one by one.
  /\b(?:margin|padding|inset|border-width|border-style|border-color|border-radius)\s*:\s*[^\s;]+\s+[^\s;]+\s+[^\s;]+\s+[^\s;]+/,
];

/** The breakpoints tokens.css lists, in rem; a max-width query may sit 0.01rem under one. */
const BREAKPOINTS_REM = [30, 40, 56, 60];

/** Declarations only: comments, and media queries (which test the screen, not lay out the page), left out. */
const declarations = (css: string): string[] =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("@media"));

describe("stylesheets", () => {
  it("are all found", () => {
    expect(STYLESHEETS).toEqual(expect.arrayContaining(["packages/ui/src/base.css", "packages/ui/src/app.css", "packages/ui/src/customer.css", "apps/dashboard/src/styles.css", "apps/counter/src/styles.css"]));
  });

  it.each(STYLESHEETS)("%s uses logical properties only", (file) => {
    const physical = declarations(readFileSync(join(repo, file), "utf8")).filter((line) => PHYSICAL.some((pattern) => pattern.test(line)));
    expect(physical).toEqual([]);
  });

  it.each(STYLESHEETS)("%s takes its layers, focus ring widths and breakpoints from the tokens", (file) => {
    const css = readFileSync(join(repo, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.match(/z-index:\s*-?\d[^;]*/g) ?? [], "z-index without a --z-* token").toEqual([]);
    // A focus rule's outline width is --focus-width's, never a number of its own.
    const focusWidths = [...css.matchAll(/([^{}]*:focus[^{}]*)\{([^{}]*)\}/g)].filter((rule) => /outline(?:-width)?:\s*[\d.]/.test(rule[2] ?? "")).map((rule) => (rule[1] ?? "").trim());
    expect(focusWidths, "focus rules with an outline width of their own").toEqual([]);
    const widths = [...css.matchAll(/@media[^{]*\((min|max)-width:\s*([\d.]+)rem\)/g)].map((match) => ({ kind: match[1], rem: Number(match[2]) }));
    const off = widths.filter(({ kind, rem }) => !BREAKPOINTS_REM.includes(rem) && !(kind === "max" && BREAKPOINTS_REM.includes(Math.round((rem + 0.01) * 100) / 100)));
    expect(off, "media queries off the breakpoints in tokens.css").toEqual([]);
  });

  it("lists the breakpoints tokens.css documents", () => {
    const listed = /Breakpoints[\s\S]*?\*\//.exec(readFileSync(join(repo, "packages/ui/src/tokens.css"), "utf8"))?.[0] ?? "";
    expect([...listed.matchAll(/([\d.]+)rem/g)].map((match) => Number(match[1]))).toEqual(BREAKPOINTS_REM);
  });

  it("catches a physical property", () => {
    const css = "a { margin-left: 1rem; }\n/* left: 0 */\n@media (min-width: 60rem) {\n  padding: 1px 2px 3px 4px;\n  padding: 1px 2px 3px;\n  width: 1px;\n  line-height: 1;\n  border-width: 2px;";
    expect(declarations(css).filter((line) => PHYSICAL.some((pattern) => pattern.test(line)))).toEqual([
      "a { margin-left: 1rem; }",
      "  padding: 1px 2px 3px 4px;",
      "  width: 1px;",
    ]);
  });
});
