import { z } from "zod";
import { apiText } from "./api-messages.js";

/** A café's card colours: the background, the text on it and the field labels (Apple pass and web card; Google takes the background). */
export interface CardColors {
  background: string;
  foreground: string;
  label: string;
}

/** Every café's colours until the operator sets its own: the espresso card every pass had before. */
export const DEFAULT_CARD_COLORS: Readonly<CardColors> = { background: "#4a2c2a", foreground: "#ffffff", label: "#ebd6be" };

/** The least contrast text and labels need against the card's background (WCAG AA for text). */
export const MIN_CARD_CONTRAST = 4.5;

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = (hex.slice(1).match(/../g) ?? []).map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2 contrast ratio of two #rrggbb colours, from 1 to 21, whichever is lighter. */
export function contrastRatio(first: string, second: string): number {
  const [light = 0, dark = 0] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** A colour as #rrggbb in either case (as a colour picker gives it), kept lowercase as the database stores it. */
export const cardColorSchema = z
  .string(apiText("Use a colour as #rrggbb, such as #4a2c2a."))
  .regex(/^#[0-9a-fA-F]{6}$/, apiText("Use a colour as #rrggbb, such as #4a2c2a."))
  .transform((value) => value.toLowerCase());

/** The three colours, refused when the text or the labels would not stand out enough from the background. */
export const cardColorsSchema = z
  .object({ background: cardColorSchema, foreground: cardColorSchema, label: cardColorSchema })
  .superRefine((colors, context) => {
    // Zod runs this even when a colour failed its own check above: contrast is only told for three real colours.
    if (![colors.background, colors.foreground, colors.label].every((color) => /^#[0-9a-f]{6}$/.test(color))) {
      return;
    }
    if (contrastRatio(colors.foreground, colors.background) < MIN_CARD_CONTRAST) {
      context.addIssue({ code: "custom", path: ["foreground"], message: apiText("Pick a text colour that stands out more from the background: at least 4.5 to 1.") });
    }
    if (contrastRatio(colors.label, colors.background) < MIN_CARD_CONTRAST) {
      context.addIssue({ code: "custom", path: ["label"], message: apiText("Pick a label colour that stands out more from the background: at least 4.5 to 1.") });
    }
  });

/** The stamp templates a café's cards draw their stamps in, empty or full (the Apple strip, the Google hero image, the web card). */
export const STAMP_SHAPES = ["circle", "cup", "plate", "bean"] as const;
export type StampShape = (typeof STAMP_SHAPES)[number];

/** Every café's shape until its owner or the operator picks another. */
export const DEFAULT_STAMP_SHAPE: StampShape = "circle";

export const stampShapeSchema = z.enum(STAMP_SHAPES, apiText("Pick one of the stamp shapes."));

/**
 * The stamp templates, drawn on a 24-unit square (the server's pass pictures and web card, the dashboard's preview):
 * `body` is filled for a collected stamp and outlined for one still to go, `extra` (a cup's handle and saucer) is
 * always outlined in the stamp's colour, and `inner` (a plate's rim, a bean's crease) is outlined in the stamp's colour
 * on an empty stamp and in the card's background on a full one. Lines are STAMP_STROKE wide.
 */
export const STAMP_SHAPE_PATHS: Readonly<Record<StampShape, { body: string; extra?: string; inner?: string }>> = {
  circle: { body: "M12 2.5a9.5 9.5 0 1 0 0 19a9.5 9.5 0 1 0 0-19Z" },
  cup: { body: "M3.5 7h12v6.5a5.5 5.5 0 0 1-5.5 5.5h-1a5.5 5.5 0 0 1-5.5-5.5Z", extra: "M15.5 9h1.75a2.75 2.75 0 0 1 0 5.5h-1.75M2.5 21.5h15" },
  plate: { body: "M12 2.5a9.5 9.5 0 1 0 0 19a9.5 9.5 0 1 0 0-19Z", inner: "M12 6.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z" },
  bean: { body: "M12 2.5c4.4 0 7 4.3 7 9.5s-2.6 9.5-7 9.5s-7-4.3-7-9.5s2.6-9.5 7-9.5Z", inner: "M12 3.5c-2.5 3-2.5 5.5 0 8.5s2.5 5.5 0 8.5" },
};

export const STAMP_STROKE = 1.75;
