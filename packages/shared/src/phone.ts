import { z } from "zod";

/** A phone number in E.164 form: "+", a country code not starting with 0, 7 to 15 digits in total (AC 4). */
export const e164PhoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, "Enter the number in international form, e.g. +96170123456.");

export type E164Phone = z.output<typeof e164PhoneSchema>;
