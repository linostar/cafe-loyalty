import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The colour tokens of tokens.css, by name without the leading dashes. */
const colours = new Map(
  [...readFileSync(new URL("tokens.css", import.meta.url), "utf8").matchAll(/--(color-[\w-]+):\s*(#[0-9a-f]{6});/gi)].map((match) => [match[1] ?? "", match[2] ?? ""]),
);

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = (hex.slice(1).match(/../g) ?? []).map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const BODY = 4.5;
const UI = 3;

/**
 * Every colour drawn on another in the styles (base.css, customer.css and the apps' stylesheets), with its minimum:
 * 4.5:1 for text, 3:1 for the borders of controls and the focus ring. A new colour token must be added here.
 */
const PAIRS: readonly [foreground: string, background: string, minimum: number][] = [
  ["color-text", "color-page", BODY],
  ["color-text", "color-surface", BODY],
  ["color-text", "color-surface-sunken", BODY],
  ["color-text", "color-accent-soft", BODY],
  ["color-text-muted", "color-page", BODY],
  ["color-text-muted", "color-surface", BODY],
  ["color-text-muted", "color-surface-sunken", BODY],
  ["color-accent-strong", "color-page", BODY],
  ["color-accent-strong", "color-surface", BODY],
  ["color-accent-strong", "color-accent-soft", BODY],
  ["color-on-accent", "color-accent", BODY],
  ["color-on-accent", "color-accent-hover", BODY],
  ["color-on-espresso", "color-espresso", BODY],
  ["color-on-espresso-muted", "color-espresso", BODY],
  ["color-success", "color-success-soft", BODY],
  ["color-success", "color-surface", BODY],
  ["color-warning", "color-warning-soft", BODY],
  ["color-danger", "color-danger-soft", BODY],
  ["color-danger", "color-surface", BODY],
  ["color-danger", "color-page", BODY],
  ["color-text", "color-heat-1", BODY],
  ["color-text", "color-heat-2", BODY],
  ["color-text", "color-heat-3", BODY],
  ["color-on-accent", "color-heat-4", BODY],
  ["color-border-strong", "color-surface", UI],
  ["color-border-strong", "color-page", UI],
  ["color-focus", "color-page", UI],
  ["color-focus", "color-surface", UI],
  ["color-focus-inverse", "color-espresso", UI],
  ["color-accent", "color-page", UI],
];

/** Decorative only: dividers and card edges, never the boundary a control needs to be seen (WCAG 1.4.11). */
const DECORATIVE = new Set(["color-border"]);

describe("colour tokens", () => {
  it.each(PAIRS)("%s on %s has at least the contrast it needs", (foreground, background, minimum) => {
    const fg = colours.get(foreground);
    const bg = colours.get(background);
    expect(fg, foreground).toBeDefined();
    expect(bg, background).toBeDefined();
    expect(contrast(fg ?? "", bg ?? "")).toBeGreaterThanOrEqual(minimum);
  });

  it("checks every colour token", () => {
    const checked = new Set([...PAIRS.flatMap(([foreground, background]) => [foreground, background]), ...DECORATIVE]);
    expect([...colours.keys()].filter((name) => !checked.has(name))).toEqual([]);
    expect(colours.size).toBeGreaterThan(20);
  });
});
