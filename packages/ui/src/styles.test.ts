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

/** A width condition on a listed breakpoint: `min-width` or `max-width` in rem, the max a hundredth under one allowed. */
const onBreakpoint = (condition: string): boolean => {
  const match = /^(min|max)-width:\s*([\d.]+)rem$/.exec(condition);
  const rem = Number(match?.[2]);
  return match !== null && (BREAKPOINTS_REM.includes(rem) || (match[1] === "max" && BREAKPOINTS_REM.some((breakpoint) => Math.abs(rem - (breakpoint - 0.01)) < 1e-9)));
};

/** Every width condition of every media query that is off the breakpoints (another unit, range syntax or calc() included). */
const offBreakpoints = (css: string): string[] =>
  [...css.matchAll(/@media([^{]*)\{/g)].flatMap((query) =>
    [...(query[1] ?? "").matchAll(/\(((?:[^()]|\([^()]*\))*\bwidth\b(?:[^()]|\([^()]*\))*)\)/g)].map((condition) => (condition[1] ?? "").trim()).filter((condition) => !onBreakpoint(condition)),
  );

/**
 * The selectors of focus rules whose outline is not --focus-width wide: an `outline-width` other than it, or an `outline`
 * shorthand without it (whatever its width is spelled as: a length, thin, medium, thick, another variable).
 */
const ownFocusWidths = (css: string): string[] =>
  [...css.matchAll(/([^{}]*:focus[^{}]*)\{([^{}]*)\}/g)]
    .filter((rule) =>
      [...(rule[2] ?? "").matchAll(/(?:^|[\s;])outline(-width)?\s*:\s*([^;]+)/g)].some(([, longhand, value = ""]) =>
        longhand === undefined ? !value.includes("var(--focus-width)") : value.trim() !== "var(--focus-width)",
      ),
    )
    .map((rule) => (rule[1] ?? "").trim());

/** The --z-* tokens tokens.css defines. */
const LAYERS = readFileSync(join(repo, "packages/ui/src/tokens.css"), "utf8").match(/--z-[\w-]+(?=\s*:)/g) ?? [];

/** Every z-index set to anything but one of those tokens (a misspelled one included). */
const ownLayers = (css: string): string[] =>
  [...css.matchAll(/z-index:\s*([^;}]*)/g)].filter((layer) => !LAYERS.some((token) => (layer[1] ?? "").trim() === `var(${token})`)).map((layer) => layer[0].trimEnd());

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
    expect(ownLayers(css), "z-index without a --z-* token").toEqual([]);
    expect(ownFocusWidths(css), "focus rules with an outline width of their own").toEqual([]);
    expect(offBreakpoints(css), "media queries off the breakpoints in tokens.css").toEqual([]);
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

  it("catches a media query off the breakpoints", () => {
    const css = [
      "@media (min-width: 40rem) {}",
      "@media (max-width: 39.99rem) {}",
      "@media (forced-colors: active), (prefers-reduced-motion: reduce), print {}",
      "@media (min-width: 45rem) and (max-width: 59.99rem) {}",
      "@media (max-width: 40.5rem) {}",
      "@media (min-width: 640px) {}",
      "@media (min-width: 40em) {}",
      "@media (width >= 40rem) {}",
      "@media (max-width: 39.994rem) {}",
      "@media (min-width: calc(40rem + 1px)) {}",
    ].join("\n");
    expect(offBreakpoints(css)).toEqual(["min-width: 45rem", "max-width: 40.5rem", "min-width: 640px", "min-width: 40em", "width >= 40rem", "max-width: 39.994rem", "min-width: calc(40rem + 1px)"]);
  });

  it("catches a focus ring width of its own", () => {
    const css = [
      "a:focus-visible { outline: var(--focus-width) solid var(--color-focus); outline-offset: 2px; }",
      ".b:focus-visible { outline-color: red; outline-style: dotted; outline-offset: 0; }",
      ".c:focus-visible { outline-width: var(--focus-width); }",
      ".d:focus { outline: 2px solid red; }",
      ".e:focus { outline: solid 2px red; }",
      ".f:focus { outline: thick solid red; }",
      ".g:focus-visible { outline-width: thin; }",
      ".h:focus-visible { color: red; outline-width: 3px; }",
      ".i:hover { outline: 4px solid red; }",
      ".j:focus-visible { outline: var(--space-1) solid var(--color-focus); }",
    ].join("\n");
    expect(ownFocusWidths(css)).toEqual([".d:focus", ".e:focus", ".f:focus", ".g:focus-visible", ".h:focus-visible", ".j:focus-visible"]);
  });

  it("catches a layer that is not a token", () => {
    const css = ".a { z-index: var(--z-overlay); }\n.b { z-index:var(--z-raised) }\n.c { z-index: 10; }\n.d { z-index: -1; }\n.e { z-index: calc(999); }\n.f { z-index: var(--other); }\n.g { z-index: var(--z-overaly); }";
    expect(LAYERS).toEqual(expect.arrayContaining(["--z-raised", "--z-overlay"]));
    expect(ownLayers(css)).toEqual(["z-index: 10", "z-index: -1", "z-index: calc(999)", "z-index: var(--other)", "z-index: var(--z-overaly)"]);
  });
});
