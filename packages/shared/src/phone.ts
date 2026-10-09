import { z } from "zod";

/** A phone number in E.164 form: "+", a country code not starting with 0, 7 to 15 digits in total (AC 4). */
export const e164PhoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, "Enter the number in international form, e.g. +96170123456.");

export type E164Phone = z.output<typeof e164PhoneSchema>;

const LEBANON = "+961";

/**
 * A phone number as typed, in E.164 form, or null if it is not a valid number. Accepts Arabic-Indic and Persian
 * digits, spaces, dashes, dots, brackets and direction marks, a leading 00, and Lebanese local forms: a leading 0
 * (03 123 456, 06 123 456) or none (70 123 456). A Lebanese number has 7 or 8 digits after +961.
 */
export function normalizePhoneInput(input: string): string | null {
  let number = input
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\s\-.()‎‏‪-‮]/g, "");
  if (number.startsWith("00")) {
    number = `+${number.slice(2)}`;
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
  return number.startsWith(LEBANON) && !/^\+961\d{7,8}$/.test(number) ? null : number;
}
