import { MAX_CENTS } from "@cafe-loyalty/shared";

/** Dollars as typed ("2", "2.5", "2.50", "$2.50") to whole cents, or null when it is not an amount up to $1,000,000. */
export function parseUsdInput(input: string): number | null {
  const match = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (match === null) {
    return null;
  }
  const [, dollars = "0", cents = ""] = match;
  const total = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return total <= MAX_CENTS ? total : null;
}

/** A whole number as typed ("9", " 12 "), or null for anything else, so a blank or a word never becomes 0 or NaN. */
export function parseWholeNumberInput(input: string): number | null {
  const trimmed = input.trim();
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : null;
}

/** Cents as an editable dollar amount: 250 -> "2.50". */
export const centsToInput = (cents: number): string => (cents / 100).toFixed(2);
