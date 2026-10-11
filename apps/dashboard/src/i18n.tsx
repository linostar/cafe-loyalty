import { fill, langFromPreferences, localiseApiMessage, type Lang, type TemplateValues } from "@cafe-loyalty/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * The dashboard in Arabic and English (AC 41). Text is written in English where it is shown, as `t("…")`; each file
 * lists the Arabic of its own text in a catalog (English as the key), and `t` takes only text its catalog or COMMON_AR
 * lists, so a string without its Arabic does not compile. Messages from the API are translated by localiseApiMessage.
 */
export type Catalog = Readonly<Record<string, string>>;

/** Text many pages use. */
const COMMON_AR = {
  "Loading…": "جارٍ التحميل…",
  "Saving…": "جارٍ الحفظ…",
  "Saved.": "تم الحفظ.",
  Cancel: "إلغاء",
  Edit: "تعديل",
  "Try again": "حاول مجدداً",
  "Name (English)": "الاسم (بالإنكليزية)",
  "Name (Arabic)": "الاسم (بالعربية)",
} as const satisfies Catalog;

type CommonText = keyof typeof COMMON_AR;

/** Where the dashboard keeps the viewer's choice: a per-browser convenience, so the browser's languages decide without it. */
const STORAGE_KEY = "cl_lang";

function storedLang(): Lang | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "ar" || value === "en" ? value : null;
  } catch {
    return null;
  }
}

const LangContext = createContext<{ lang: Lang; setLang: (lang: Lang) => void }>({ lang: "en", setLang: () => undefined });

/** Holds the language: the viewer's last choice, else the browser's languages; sets the page's lang and direction. */
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => storedLang() ?? langFromPreferences(navigator.languages));
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not kept (private window, blocked storage): this page still switches.
    }
  }, []);
  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export const useLang = (): Lang => useContext(LangContext).lang;

export type Translate<C extends Catalog> = (text: Extract<keyof C, string> | CommonText, values?: TemplateValues) => string;

/** `t` for a file's catalog: the text in the page's language with its `{name}` placeholders filled. */
export function useT<C extends Catalog>(catalog: C): Translate<C> {
  const lang = useLang();
  return useCallback(
    (text, values) => fill(lang, lang === "ar" ? ((catalog as Catalog)[text] ?? (COMMON_AR as Catalog)[text] ?? text) : text, values),
    [lang, catalog],
  );
}

const NO_TEXT = {} as const satisfies Catalog;

/** `t` for COMMON_AR's text alone. */
export const useCommonT = (): Translate<typeof NO_TEXT> => useT(NO_TEXT);

/** A message from the API (or the dashboard's own reading of a failure) in the page's language. */
export function useApiText(): (message: string) => string {
  const lang = useLang();
  return useCallback((message: string) => localiseApiMessage(lang, message), [lang]);
}

const LOCALES: Readonly<Record<Lang, string>> = { en: "en-GB", ar: "ar-LB-u-nu-latn" };
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** A date and time format in `lang` (Latin digits in Arabic, like the amounts), made once per options. */
export function dateFormat(lang: Lang, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${lang} ${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(LOCALES[lang], options);
    dateFormats.set(key, format);
  }
  return format;
}

/** Switches to the other language; its label is in that language, for whoever reads it. */
export function LanguageSwitch() {
  const { lang, setLang } = useContext(LangContext);
  const other: Lang = lang === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      className="lang-switch"
      lang={other}
      onClick={() => {
        setLang(other);
      }}
    >
      {other === "ar" ? "العربية" : "English"}
    </button>
  );
}
