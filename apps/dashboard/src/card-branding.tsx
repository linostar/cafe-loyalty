import { apiText, type CardColors } from "@cafe-loyalty/shared";
import { useId, useState, type CSSProperties } from "react";
import { Form, FormError, Notice, useFocusOnChange, useFocusWhenInvalid, useSubmit } from "./forms.js";
import { useApiText, useT } from "./i18n.js";

const AR = {
  "Card preview": "معاينة البطاقة",
  "Loyalty card": "بطاقة الولاء",
  "4 of 9 stamps": "4 من 9 أختام",
  Logo: "الشعار",
  "Logo of {name}": "شعار {name}",
  "A PNG or JPEG of at most 2 MB, at least 64 pixels on each side. A square logo fits best: Google Wallet shows it in a circle.":
    "صورة PNG أو JPEG بحجم 2 ميغابايت كحد أقصى، و64 بكسل على الأقل لكل جانب. الشعار المربّع هو الأنسب: تعرضه محفظة Google داخل دائرة.",
  "Upload logo": "رفع الشعار",
  "Uploading…": "جارٍ الرفع…",
  "Remove logo": "إزالة الشعار",
  "Removing…": "جارٍ الإزالة…",
  "Saved. Cards in wallets show it within a few minutes.": "تم الحفظ. يظهر الشعار على البطاقات في المحافظ خلال دقائق.",
  "Logo removed.": "أُزيل الشعار.",
} as const;

/** A café's logo as the dashboard loads it (its domain forwards only /api to the server). */
export const logoUrl = (hash: string): string => `/api/logos/${hash}.png`;

/**
 * The face of a café's card as customers see it (web card and wallets): its colours, logo and name, with sample stamps.
 * The colours are data, set through the face's custom properties (as the web card does).
 */
export function CardPreview({ name, colors, logoHash }: { name: string; colors: CardColors; logoHash: string | null }) {
  const t = useT(AR);
  const face = { "--card-background": colors.background, "--card-foreground": colors.foreground, "--card-label": colors.label } as CSSProperties;
  return (
    <figure className="card-preview">
      <div className="card-preview-face" style={face}>
        {logoHash === null ? null : <img src={logoUrl(logoHash)} alt="" width="48" height="48" />}
        <p className="card-preview-label">{t("Loyalty card")}</p>
        <p className="card-preview-name">{name}</p>
        <p className="card-preview-stamps">{t("4 of 9 stamps")}</p>
      </div>
      <figcaption className="hint">{t("Card preview")}</figcaption>
    </figure>
  );
}

/** A file's contents as base64, as the logo routes take it (JSON bodies only). */
const base64Of = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL gives a string: data:<type>;base64,<data>.
      resolve(typeof reader.result === "string" ? reader.result.replace(/^data:[^,]*,/, "") : "");
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("The file could not be read."));
    };
    reader.readAsDataURL(file);
  });

const LOGO_TYPES = ["image/png", "image/jpeg"];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Uploading or removing a café's logo (the owner's Card section, the operator's café page). The file is checked here for
 * its type and size first, with the server's own messages; the server checks it again and makes the cards' sizes.
 */
export function LogoForm({
  cafeName,
  logoHash,
  upload,
  remove,
}: {
  cafeName: string;
  logoHash: string | null;
  upload: (image: string) => Promise<unknown>;
  remove: () => Promise<unknown>;
}) {
  const t = useT(AR);
  const api = useApiText();
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  // In English, as the API words it, and translated when shown.
  const [problem, setProblem] = useState<string | null>(null);
  // One request at a time for the form: an upload and a removal never race (submit ignores a second while one is out).
  const sending = useSubmit();
  const [action, setAction] = useState<"upload" | "remove">("upload");
  const [said, setSaid] = useState<"saved" | "removed" | null>(null);
  // Remove goes with the logo: focus then moves to the file field, not to the page (WCAG 2.4.3).
  const [removals, setRemovals] = useState(0);
  const field = useFocusOnChange<HTMLDivElement>(removals);
  const error = problem ?? sending.fieldErrors.image;
  const input = useFocusWhenInvalid(error !== undefined);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <Form
      aria-label={t("Logo of {name}", { name: cafeName })}
      onSubmit={(event) => {
        event.preventDefault();
        if (sending.pending) {
          return;
        }
        setSaid(null);
        if (file === null || !LOGO_TYPES.includes(file.type)) {
          setProblem(apiText("Upload the logo as a PNG or JPEG image."));
          return;
        }
        if (file.size > LOGO_MAX_BYTES) {
          setProblem(apiText("Use a logo of at most 2 MB."));
          return;
        }
        setProblem(null);
        setAction("upload");
        void sending.submit(async () => upload(await base64Of(file))).then((result) => {
          if (!result.ok) {
            return;
          }
          setSaid("saved");
          // The file sent is cleared, from the field too, unless another was chosen meanwhile (that one stays, to send).
          if (input.current?.files?.[0] === file) {
            input.current.value = "";
            setFile(null);
          }
        });
      }}
    >
      <FormError message={sending.error} />
      <div ref={field} className="field">
        <label htmlFor={id}>{t("Logo")}</label>
        <input
          ref={input}
          id={id}
          name="logo"
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setProblem(null);
            setSaid(null);
          }}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
        />
        <p id={hintId} className="hint">
          {t("A PNG or JPEG of at most 2 MB, at least 64 pixels on each side. A square logo fits best: Google Wallet shows it in a circle.")}
        </p>
        {error === undefined ? null : (
          <p id={errorId} className="field-error">
            {api(error)}
          </p>
        )}
      </div>
      <div className="actions">
        <button type="submit" aria-disabled={sending.pending || undefined}>
          {sending.pending && action === "upload" ? t("Uploading…") : t("Upload logo")}
        </button>
        {logoHash === null ? null : (
          <button
            type="button"
            aria-disabled={sending.pending || undefined}
            onClick={() => {
              if (sending.pending) {
                return;
              }
              setSaid(null);
              setAction("remove");
              void sending.submit(remove).then((result) => {
                if (result.ok) {
                  setSaid("removed");
                  setRemovals((count) => count + 1);
                }
              });
            }}
          >
            {sending.pending && action === "remove" ? t("Removing…") : t("Remove logo")}
          </button>
        )}
      </div>
      <Notice>{said === "saved" ? t("Saved. Cards in wallets show it within a few minutes.") : said === "removed" ? t("Logo removed.") : null}</Notice>
    </Form>
  );
}
