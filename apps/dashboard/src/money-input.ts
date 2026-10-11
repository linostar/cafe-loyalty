import { MAX_CENTS, toLatinDigits } from "@cafe-loyalty/shared";

/** Input as typed on any keyboard: Arabic-Indic and Persian digits as ASCII, the Arabic decimal separator (٫) as ".". */
const normalized = (input: string): string => toLatinDigits(input).replaceAll("٫", ".").trim();

/** Dollars as typed ("2", "2.5", "2.50", "$2.50", "٢٫٥٠") to whole cents, or null when it is not an amount up to $1,000,000. */
export function parseUsdInput(input: string): number | null {
  const match = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(normalized(input));
  if (match === null) {
    return null;
  }
  const [, dollars = "0", cents = ""] = match;
  const total = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return total <= MAX_CENTS ? total : null;
}

/** A whole number as typed ("9", " 12 ", "١٢"), or null for anything else, so a blank or a word never becomes 0 or NaN. */
export function parseWholeNumberInput(input: string): number | null {
  const trimmed = normalized(input);
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : null;
}

/** Cents as an editable dollar amount: 250 -> "2.50". */
export const centsToInput = (cents: number): string => (cents / 100).toFixed(2);
