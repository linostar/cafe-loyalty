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
