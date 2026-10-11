import type { DisplayLocale } from "./money.js";

/** The two languages of every screen (AC 41). */
export type Lang = DisplayLocale;

export type TemplateValues = Readonly<Record<string, string | number>>;

/** Arabic's plural forms of one counted phrase, `{n}` the count (CLDR's six; `other` covers any left out). */
export type ArabicPlural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/** One counted phrase in both languages, such as "{n} cards": English one and other, Arabic's forms. */
export interface Plural {
  en: { one: string; other: string };
  ar: ArabicPlural;
}

/**
 * The language for a browser's preferences (`navigator.languages`): the first Arabic or English one, else Arabic, as the
 * customer pages choose.
 */
export function langFromPreferences(preferences: readonly string[]): Lang {
  for (const tag of preferences) {
    const lower = tag.toLowerCase();
    if (lower.startsWith("ar")) {
      return "ar";
    }
    if (lower.startsWith("en")) {
      return "en";
    }
  }
  return "ar";
}

/**
 * `template` with its `{name}` placeholders filled from `values` (a missing one stays as written). In Arabic each value
 * is isolated (U+2068 … U+2069), so a Latin name, an email or a number keeps its own order inside right-to-left text.
 */
export function fill(lang: Lang, template: string, values: TemplateValues = {}): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) {
      return placeholder;
    }
    return lang === "ar" ? `⁨${String(value)}⁩` : String(value);
  });
}

const arabicPlurals = new Intl.PluralRules("ar");

/** The Arabic form for `n`. */
export const arabicPluralForm = (forms: ArabicPlural, n: number): string => forms[arabicPlurals.select(n)] ?? forms.other;

/** `n` of a counted phrase in `lang`, with `{n}` and any other placeholders filled: "1 card", "3 cards", "بطاقتان". */
export function plural(lang: Lang, forms: Plural, n: number, values: TemplateValues = {}): string {
  const template = lang === "en" ? (n === 1 ? forms.en.one : forms.en.other) : arabicPluralForm(forms.ar, n);
  return fill(lang, template, { ...values, n });
}

/** Arabic-Indic and Persian digits as ASCII digits, so a number typed on an Arabic keyboard reads like any other. */
export const toLatinDigits = (input: string): string =>
  input.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
