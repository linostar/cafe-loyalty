import { LOGO_STAMP_SHAPE, PICTURE_STAMP_SHAPE, STAMP_SHAPES, STAMP_SHAPE_PATHS, STAMP_STROKE, apiText, isSilhouetteShape, stampGrid, type ApiText, type CardColors, type StampShape } from "@cafe-loyalty/shared";
import { useId, useState, type CSSProperties } from "react";
import { Form, FormError, Notice, useFocusOnChange, useFocusWhenInvalid, useSubmit } from "./forms.js";
import { useApiText, useT } from "./i18n.js";

const AR = {
  "Card preview": "معاينة البطاقة",
  "Loyalty card": "بطاقة الولاء",
  "4 of 9 stamps": "4 من 9 أختام",
  "Stamp shape": "شكل الأختام",
  "Cards show the stamps collected as full shapes and the ones to go as outlines.": "تُظهر البطاقات الأختام المجمّعة أشكالاً ممتلئة، والباقية أشكالاً مفرّغة.",
  "From logo": "من الشعار",
  "From picture": "من الصورة",
  Circle: "دائرة",
  Cup: "فنجان",
  Plate: "طبق",
  "Coffee bean": "حبّة بن",
  "Steaming cup": "فنجان ساخن",
  "Ice cream": "بوظة",
  Cake: "قطعة كاتو",
  Burger: "برغر",
  "Save shape": "حفظ الشكل",
  "Saving…": "جارٍ الحفظ…",
  "Saved. Cards in wallets show the new shape within a few minutes.": "تم الحفظ. يظهر الشكل الجديد على البطاقات في المحافظ خلال دقائق.",
  "Saved. Cards in wallets show it within a few minutes.": "تم الحفظ. يظهر الشعار على البطاقات في المحافظ خلال دقائق.",
  Logo: "الشعار",
  "Logo of {name}": "شعار {name}",
  "A PNG or JPEG of at most 2 MB, at least 64 pixels on each side. A square logo fits best: Google Wallet shows it in a circle.":
    "صورة PNG أو JPEG بحجم 2 ميغابايت كحد أقصى، و64 بكسل على الأقل لكل جانب. الشعار المربّع هو الأنسب: تعرضه محفظة Google داخل دائرة.",
  "Upload logo": "رفع الشعار",
  "Uploading…": "جارٍ الرفع…",
  "Remove logo": "إزالة الشعار",
  "Removing…": "جارٍ الإزالة…",
  "Logo removed.": "أُزيل الشعار.",
  "Stamp picture": "صورة الأختام",
  "Stamp picture of {name}": "صورة أختام {name}",
  "A PNG or JPEG of at most 2 MB, at least 64 pixels on each side. Its dark parts become the stamp; it never shows as the card's logo.":
    "صورة PNG أو JPEG بحجم 2 ميغابايت كحد أقصى، و64 بكسل على الأقل لكل جانب. تصبح أجزاؤها الداكنة هي الختم، ولا تظهر أبداً كشعار للبطاقة.",
  "Upload picture": "رفع الصورة",
  "Replace picture": "استبدال الصورة",
  "Remove picture": "إزالة الصورة",
  "Saved. Cards in wallets show the new stamps within a few minutes.": "تم الحفظ. تظهر الأختام الجديدة على البطاقات في المحافظ خلال دقائق.",
  "Picture removed.": "أُزيلت الصورة.",
} as const;

/** Each stamp shape's name, as the picker lists them. */
const SHAPE_NAMES = {
  circle: "Circle",
  cup: "Cup",
  steamcup: "Steaming cup",
  plate: "Plate",
  bean: "Coffee bean",
  icecream: "Ice cream",
  cake: "Cake",
  burger: "Burger",
  logo: "From logo",
  picture: "From picture",
} as const satisfies Record<StampShape, keyof typeof AR>;

/**
 * One stamp in a shape (STAMP_SHAPE_PATHS, as the cards draw it), in currentColor: full (filled and outlined, so as big
 * as an empty one) or outlined. A full stamp's inner lines take the card's background (`.stamp-icon-inner`, app.css).
 * "From logo" and "From picture" are the silhouette (`maskHash`'s, stampMaskUrl) masking currentColor, faded when empty;
 * a circle without one.
 */
export function StampIcon({ shape, full, maskHash }: { shape: StampShape; full: boolean; maskHash: string | null }) {
  if (isSilhouetteShape(shape) && maskHash !== null) {
    return (
      <span
        className={full ? "stamp-icon stamp-icon-logo" : "stamp-icon stamp-icon-logo is-empty"}
        style={{ "--stamp-logo": `url("${stampMaskUrl(maskHash)}")` } as CSSProperties}
        aria-hidden="true"
      />
    );
  }
  const { body, extra, inner } = STAMP_SHAPE_PATHS[isSilhouetteShape(shape) ? "circle" : shape];
  const line = { fill: "none", stroke: "currentColor", strokeWidth: STAMP_STROKE, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg className="stamp-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {full ? <path d={body} {...line} fill="currentColor" /> : <path d={body} {...line} />}
      {extra === undefined ? null : <path d={extra} {...line} />}
      {inner === undefined ? null : <path className={full ? "stamp-icon-inner" : undefined} d={inner} {...line} />}
    </svg>
  );
}

/** The preview's sample program: 4 of 9 stamps, in rows as the cards lay them out (stampGrid). */
const SAMPLE_STAMPS = 9;

/** A café's logo as the dashboard loads it (its domain forwards only /api to the server). */
export const logoUrl = (hash: string): string => `/api/logos/${hash}.png`;

/** A silhouette (a logo's or a "From picture" picture's, by its own hash), which those stamps are drawn as. */
export const stampMaskUrl = (hash: string): string => `/api/logos/${hash}-stamp.png`;

/**
 * The face of a café's card as customers see it (web card and wallets): its colours, logo and name, with sample stamps
 * in its shape (4 of 9). The colours are data, set through the face's custom properties (as the web card does).
 */
export function CardPreview({
  name,
  colors,
  logoHash,
  stampMaskHash,
  pictureMaskHash,
  stampShape,
}: {
  name: string;
  colors: CardColors;
  logoHash: string | null;
  stampMaskHash: string | null;
  pictureMaskHash: string | null;
  stampShape: StampShape;
}) {
  const t = useT(AR);
  const face = { "--card-background": colors.background, "--card-foreground": colors.foreground, "--card-label": colors.label } as CSSProperties;
  return (
    <figure className="card-preview">
      <div className="card-preview-face" style={face}>
        {logoHash === null ? null : <img src={logoUrl(logoHash)} alt="" width="48" height="48" />}
        <p className="card-preview-label">{t("Loyalty card")}</p>
        <p className="card-preview-name">{name}</p>
        <p className="visually-hidden">{t("4 of 9 stamps")}</p>
        <ol className="card-preview-stamps" style={{ "--stamp-columns": stampGrid(SAMPLE_STAMPS).columns } as CSSProperties} aria-hidden="true">
          {Array.from({ length: SAMPLE_STAMPS }, (_, index) => (
            <li key={index} className={index < 4 ? "is-filled" : undefined}>
              <StampIcon shape={stampShape} full={index < 4} maskHash={stampShape === PICTURE_STAMP_SHAPE ? pictureMaskHash : stampMaskHash} />
            </li>
          ))}
        </ol>
      </div>
      <figcaption className="hint">{t("Card preview")}</figcaption>
    </figure>
  );
}

/**
 * Picking the shape a café's cards draw their stamps in (the owner's Card section, the operator's café page): the
 * templates (STAMP_SHAPES) as radio buttons, each with its picture, saved together. "From logo" is listed only while
 * the café's logo has a silhouette (`maskHash`), drawn from it; removing the logo moves the café to the circle (the server).
 * "From picture" is always listed: picked, its picture's upload, replacement and removal show under the shapes (a form
 * of its own, `picture`); an upload also picks it (the server), and removing the picture moves the café to the circle.
 */
export function StampShapeForm({
  cafeName,
  shape,
  maskHash,
  pictureMaskHash,
  save,
  picture,
}: {
  cafeName: string;
  shape: StampShape;
  maskHash: string | null;
  pictureMaskHash: string | null;
  save: (shape: StampShape) => Promise<unknown>;
  picture: { upload: (image: string) => Promise<unknown>; remove: () => Promise<unknown> };
}) {
  const t = useT(AR);
  const id = useId();
  const [picked, setPicked] = useState(shape);
  const sending = useSubmit();
  const options: readonly StampShape[] = maskHash === null ? [...STAMP_SHAPES, PICTURE_STAMP_SHAPE] : [...STAMP_SHAPES, LOGO_STAMP_SHAPE, PICTURE_STAMP_SHAPE];
  return (
    <>
      <Form
        aria-label={t("Stamp shape")}
        // A pick while a save is on its way: "Saved." would claim the new pick was saved.
        onChange={sending.clearDone}
        onSubmit={(event) => {
          event.preventDefault();
          if (sending.pending) {
            return;
          }
          void sending.submit(() => save(picked));
        }}
      >
        <FormError message={sending.error} />
        <fieldset aria-describedby={`${id}-hint`}>
          <legend>{t("Stamp shape")}</legend>
          <p id={`${id}-hint`} className="hint">
            {t("Cards show the stamps collected as full shapes and the ones to go as outlines.")}
          </p>
          <div className="choices stamp-shapes">
            {options.map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name={`${id}-shape`}
                  value={option}
                  checked={picked === option}
                  onChange={() => {
                    setPicked(option);
                  }}
                />{" "}
                <StampIcon shape={option} full maskHash={option === PICTURE_STAMP_SHAPE ? pictureMaskHash : maskHash} />
                {t(SHAPE_NAMES[option])}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="actions">
          <button type="submit" aria-disabled={sending.pending || undefined}>
            {sending.pending ? t("Saving…") : t("Save shape")}
          </button>
        </div>
        <Notice>{sending.done ? t("Saved. Cards in wallets show the new shape within a few minutes.") : null}</Notice>
      </Form>
      {picked === PICTURE_STAMP_SHAPE ? <LogoForm kind="picture" cafeName={cafeName} logoHash={pictureMaskHash} upload={picture.upload} remove={picture.remove} /> : null}
    </>
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

/** What LogoForm says, for a logo or for a "From picture" picture (the same upload, the server's own messages). */
const IMAGE_TEXT = {
  logo: {
    form: "Logo of {name}",
    label: "Logo",
    hint: "A PNG or JPEG of at most 2 MB, at least 64 pixels on each side. A square logo fits best: Google Wallet shows it in a circle.",
    upload: "Upload logo",
    replace: "Upload logo",
    remove: "Remove logo",
    saved: "Saved. Cards in wallets show it within a few minutes.",
    removed: "Logo removed.",
    notAnImage: apiText("Upload the logo as a PNG or JPEG image."),
    tooLarge: apiText("Use a logo of at most 2 MB."),
  },
  picture: {
    form: "Stamp picture of {name}",
    label: "Stamp picture",
    hint: "A PNG or JPEG of at most 2 MB, at least 64 pixels on each side. Its dark parts become the stamp; it never shows as the card's logo.",
    upload: "Upload picture",
    replace: "Replace picture",
    remove: "Remove picture",
    saved: "Saved. Cards in wallets show the new stamps within a few minutes.",
    removed: "Picture removed.",
    notAnImage: apiText("Upload the picture as a PNG or JPEG image."),
    tooLarge: apiText("Use a picture of at most 2 MB."),
  },
} as const satisfies Record<string, Record<"form" | "label" | "hint" | "upload" | "replace" | "remove" | "saved" | "removed", keyof typeof AR> & Record<"notAnImage" | "tooLarge", ApiText>>;

/**
 * Uploading or removing a café's logo (the owner's Card section, the operator's café page), or, as `kind="picture"`, its
 * "From picture" picture (StampShapeForm; `logoHash` is then its silhouette's, shown as the stamp). The file is checked
 * here for its type and size first, with the server's own messages; the server checks it again and makes the cards' sizes.
 */
export function LogoForm({
  kind = "logo",
  cafeName,
  logoHash,
  upload,
  remove,
}: {
  kind?: keyof typeof IMAGE_TEXT;
  cafeName: string;
  logoHash: string | null;
  upload: (image: string) => Promise<unknown>;
  remove: () => Promise<unknown>;
}) {
  const t = useT(AR);
  const words = IMAGE_TEXT[kind];
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
      aria-label={t(words.form, { name: cafeName })}
      onSubmit={(event) => {
        event.preventDefault();
        if (sending.pending) {
          return;
        }
        setSaid(null);
        if (file === null || !LOGO_TYPES.includes(file.type)) {
          setProblem(words.notAnImage);
          return;
        }
        if (file.size > LOGO_MAX_BYTES) {
          setProblem(words.tooLarge);
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
        {kind === "picture" && logoHash !== null ? <StampIcon shape={PICTURE_STAMP_SHAPE} full maskHash={logoHash} /> : null}
        <label htmlFor={id}>{t(words.label)}</label>
        <input
          ref={input}
          id={id}
          name={kind}
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
          {t(words.hint)}
        </p>
        {error === undefined ? null : (
          <p id={errorId} className="field-error">
            {api(error)}
          </p>
        )}
      </div>
      <div className="actions">
        <button type="submit" aria-disabled={sending.pending || undefined}>
          {sending.pending && action === "upload" ? t("Uploading…") : t(logoHash === null ? words.upload : words.replace)}
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
            {sending.pending && action === "remove" ? t("Removing…") : t(words.remove)}
          </button>
        )}
      </div>
      <Notice>{said === "saved" ? t(words.saved) : said === "removed" ? t(words.removed) : null}</Notice>
    </Form>
  );
}
