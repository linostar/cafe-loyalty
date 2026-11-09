import { z } from "zod";
import { apiText } from "./api-messages.js";
import { toLatinDigits } from "./i18n.js";

/** A phone number in E.164 form: "+", a country code not starting with 0, 7 to 15 digits in total (AC 4). */
export const e164PhoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, apiText("Enter the number in international form, e.g. +96170123456."));

export type E164Phone = z.output<typeof e164PhoneSchema>;

const LEBANON = "+961";
/**
 * A Lebanese number after +961: 7 digits for a landline area code or the old 03 mobiles (1, 3-9 first), or 8 digits
 * for today's mobile prefixes (70, 71, 76, 78, 79, 81).
 */
const LEBANESE_NUMBER = /^\+961(?:[13-9]\d{6}|(?:7[01689]|81)\d{6})$/;
/** Spaces, dashes, dots, brackets and the invisible direction marks phones and copy-paste insert. */
const SEPARATORS = /[\s\-.()؜‎‏‪-‮⁦-⁩]/g;

/** The country code signup's code field starts with (Lebanon). */
export const DEFAULT_COUNTRY_CODE = LEBANON;

/**
 * A country code as typed in signup's code field, as "+" and its digits, or null: "+" or "00" (or nothing) and 1 to 3
 * digits not starting with 0, Arabic-Indic and Persian digits, spaces and direction marks accepted.
 */
export function parseCountryCode(input: string): string | null {
  const match = /^(?:\+|00)?([1-9]\d{0,2})$/.exec(toLatinDigits(input).replace(SEPARATORS, ""));
  return match === null ? null : `+${match[1] ?? ""}`;
}

/**
 * A phone number as typed, in E.164 form, or null if it is not a valid number. Accepts Arabic-Indic and Persian
 * digits, spaces, dashes, dots, brackets and direction marks, a leading 00, and a "(0)" trunk prefix after the country
 * code. A number without its own "+" or "00" code takes `countryCode` (parseCountryCode's form; Lebanon unless given),
 * its leading 0 trunk prefix dropped; Lebanese local forms (03 123 456, 70 123 456) and 961 without the + work as
 * before. Lebanese numbers must use a real prefix. ponytail: a leading 0 is taken for a trunk prefix in every country,
 * so a number whose 0 is part of it (an Italian landline) must be typed with its own +39.
 */
export function normalizePhoneInput(input: string, countryCode: string = LEBANON): string | null {
  let number = toLatinDigits(input)
    .replace(/\(0\)/g, "")
    .replace(SEPARATORS, "");
  if (number.startsWith("00")) {
    number = `+${number.slice(2)}`;
  } else if (countryCode === LEBANON && /^961\d{7,8}$/.test(number)) {
    // Unambiguous: a Lebanese local number has at most 8 digits.
    number = `+${number}`;
  } else if (!number.startsWith("+")) {
    number = `${countryCode}${number.startsWith("0") ? number.slice(1) : number}`;
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
