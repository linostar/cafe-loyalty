import { z } from "zod";

/** A phone number in E.164 form: "+", a country code not starting with 0, 7 to 15 digits in total (AC 4). */
export const e164PhoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, "Enter the number in international form, e.g. +96170123456.");

export type E164Phone = z.output<typeof e164PhoneSchema>;

const LEBANON = "+961";
/**
 * A Lebanese number after +961: 7 digits for a landline area code or the old 03 mobiles (1, 3-9 first), or 8 digits
 * for today's mobile prefixes (70, 71, 76, 78, 79, 81).
 */
const LEBANESE_NUMBER = /^\+961(?:[13-9]\d{6}|(?:7[01689]|81)\d{6})$/;
/** Spaces, dashes, dots, brackets and the invisible direction marks phones and copy-paste insert. */
const SEPARATORS = /[\s\-.()؜‎‏‪-‮⁦-⁩]/g;

/**
 * A phone number as typed, in E.164 form, or null if it is not a valid number. Accepts Arabic-Indic and Persian
 * digits, spaces, dashes, dots, brackets and direction marks, a leading 00, a "(0)" trunk prefix after the country
 * code, Lebanese local forms (a leading 0 as in 03 123 456, or none as in 70 123 456) and 961 without the +.
 * Lebanese numbers must use a real prefix.
 */
export function normalizePhoneInput(input: string): string | null {
  let number = input
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\(0\)/g, "")
    .replace(SEPARATORS, "");
  if (number.startsWith("00")) {
    number = `+${number.slice(2)}`;
  } else if (/^961\d{7,8}$/.test(number)) {
    // Unambiguous: a Lebanese local number has at most 8 digits.
    number = `+${number}`;
  } else if (!number.startsWith("+")) {
    number = `${LEBANON}${number.startsWith("0") ? number.slice(1) : number}`;
  }
  // "+961 03 ..." keeps the local 0 by habit.
  if (number.startsWith(`${LEBANON}0`)) {
    number = `${LEBANON}${number.slice(LEBANON.length + 1)}`;
  }
  if (!e164PhoneSchema.safeParse(number).success) {
    return null;
  }
  return number.startsWith(LEBANON) && !LEBANESE_NUMBER.test(number) ? null : number;
}
