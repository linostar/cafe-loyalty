import {
  WIN_BACK_MAX_COOLDOWN_DAYS,
  WIN_BACK_OFFER_DAYS,
  cafeSetupSchema,
  formatUsd,
  joinLinkSchema,
  plural,
  type CafeSetup,
  type OrderType,
  type WinBackSettings,
} from "@cafe-loyalty/shared";
import { useState, type ReactNode } from "react";
import { renderSVG } from "uqr";
import { apiRequest } from "./api.js";
import { ConfirmButton, Field, Form, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
import type { UnsavedChanges } from "./unsaved-changes.js";
import { useLang, useT, type Later, type Translate } from "./i18n.js";
import { centsToInput, parseUsdInput, parseWholeNumberInput } from "./money-input.js";
import { PageStatus, useApiData } from "./session.js";

const AR = {
  "Café name": "اسم المقهى",
  Name: "الاسم",
  "Save name": "حفظ الاسم",
  "Google review link": "رابط التقييم على Google",
  'About two hours after a visit, each customer\'s card links to a feedback page. Every customer sees this link there, beside a private message to you. Find it in your Google Business Profile under "Ask for reviews".':
    "بعد نحو ساعتين من الزيارة، تعرض بطاقة كل زبون رابطاً إلى صفحة الملاحظات. يرى كل زبون هذا الرابط هناك، إلى جانب رسالة خاصة إليك. تجده في ملفك على Google Business Profile تحت \"Ask for reviews\" (اطلب تقييمات).",
  "Review link": "رابط التقييم",
  "Leave it empty to show no review link.": "اتركه فارغاً كي لا يظهر أي رابط تقييم.",
  "Save review link": "حفظ رابط التقييم",
  "Enter a whole number, such as 9.": "أدخل عدداً صحيحاً، مثل 9.",
  "Loyalty program": "برنامج الولاء",
  "Set the program before baristas start giving stamps.": "اضبط البرنامج قبل أن يبدأ الباريستا بمنح الأختام.",
  "Stamps for a reward": "الأختام اللازمة للمكافأة",
  "1 to 50.": "من 1 إلى 50.",
  "Reward (English)": "المكافأة (بالإنكليزية)",
  "Reward (Arabic)": "المكافأة (بالعربية)",
  "Save program": "حفظ البرنامج",
  "Enter a whole percentage from 0 to 1000, such as 30.": "أدخل نسبة مئوية صحيحة من 0 إلى 1000، مثل 30.",
  "Minimum margin": "الحد الأدنى لهامش الربح",
  "Minimum margin over cost (%)": "الحد الأدنى لهامش الربح فوق التكلفة (%)",
  "Campaigns never sell an item for less than its cost plus this much: 30% keeps a drink that costs $1.00 at $1.30 or more. Running campaigns keep the margin they started with.":
    "لا تبيع الحملات أي صنف بأقل من تكلفته زائد هذه النسبة: 30% تُبقي مشروباً تكلفته $1.00 بسعر $1.30 أو أكثر. تحتفظ الحملات الجارية بالهامش الذي بدأت به.",
  "Save margin": "حفظ الهامش",
  "Enter a whole percentage from 1 to 100.": "أدخل نسبة مئوية صحيحة من 1 إلى 100.",
  "Enter an amount in dollars, such as 0.50.": "أدخل مبلغاً بالدولار، مثل 0.50.",
  "Enter a whole number of days from {min} to {max}.": "أدخل عدداً صحيحاً من الأيام، من {min} إلى {max}.",
  "Welcome-back offer": "عرض العودة",
  "When a regular (3 visits or more) stays away much longer than usual, at least 2 weeks, their card offers this off their next visit, for {days} days, if they agreed to receive offers. It never takes an item below its minimum margin.":
    "حين يغيب زبون دائم (3 زيارات أو أكثر) أطول بكثير من المعتاد، أسبوعين على الأقل، تعرض بطاقته هذا الخصم على زيارته التالية لمدة {days} يوماً، إن وافق على تلقي العروض. لا ينزل العرض بأي صنف دون الحد الأدنى لهامش ربحه.",
  Discount: "الخصم",
  "No offer": "بلا عرض",
  "Percent off": "خصم بنسبة مئوية",
  "Amount off each item": "خصم مبلغ عن كل صنف",
  Percentage: "النسبة المئوية",
  "Amount (USD)": "المبلغ (بالدولار)",
  "A whole number, such as 15.": "عدد صحيح، مثل 15.",
  "Such as 0.50.": "مثل 0.50.",
  "Days before the same card can get it again": "الأيام قبل أن تحصل البطاقة نفسها عليه مجدداً",
  "At least {days}, how long an offer lasts. Offers already given keep their terms.": "{days} على الأقل، وهي مدة العرض. تحتفظ العروض الممنوحة سابقاً بشروطها.",
  "Save welcome-back offer": "حفظ عرض العودة",
  "Enter a price in dollars up to 1,000,000, such as 2.50.": "أدخل سعراً بالدولار حتى 1,000,000، مثل 2.50.",
  "Enter a cost in dollars up to 1,000,000, such as 0.70.": "أدخل تكلفة بالدولار حتى 1,000,000، مثل 0.70.",
  "Enter a whole number, such as 1.": "أدخل عدداً صحيحاً، مثل 1.",
  "Add an order type": "إضافة نوع طلب",
  "Edit {name}": "تعديل {name}",
  "Price (USD)": "السعر (بالدولار)",
  "Cost to make (USD)": "تكلفة التحضير (بالدولار)",
  "What one costs you in ingredients and cup. Offers never go below cost.": "كلفة الصنف الواحد عليك من مكوّنات وكوب. لا تنزل العروض أبداً دون التكلفة.",
  "Stamps earned": "الأختام المكتسبة",
  "0 to 10.": "من 0 إلى 10.",
  "On sale (shown at the counter)": "معروض للبيع (يظهر على الكاونتر)",
  "Add order type": "إضافة نوع الطلب",
  "Save changes": "حفظ التغييرات",
  "· ": "· ",
  "not on sale": "غير معروض للبيع",
  "{price} · cost {cost} · {stamps}": "{price} · التكلفة {cost} · {stamps}",
  "Customer signup QR": "رمز QR لتسجيل الزبائن",
  "Print this and put it at the counter. Customers scan it to get their loyalty card.": "اطبعه وضعه على الكاونتر. يمسحه الزبائن للحصول على بطاقة الولاء.",
  "QR code customers scan to get a loyalty card": "رمز QR يمسحه الزبائن للحصول على بطاقة ولاء",
  Print: "طباعة",
  "Replace the code only if the printed one was misused: the old one stops working at once.": "لا تستبدل الرمز إلا إذا أُسيء استخدام الرمز المطبوع: يتوقف الرمز القديم عن العمل فوراً.",
  "Replace code": "استبدال الرمز",
  "Yes, replace the code": "نعم، استبدل الرمز",
  Café: "المقهى",
  "Your program, menu and offers. Each part saves on its own.": "برنامجك وقائمتك وعروضك. يُحفظ كل جزء وحده.",
  "Sections of this page": "أقسام هذه الصفحة",
  Program: "البرنامج",
  Menu: "القائمة",
  "Offers and welcome-back": "العروض وعرض العودة",
  "Signup and reviews": "التسجيل والتقييمات",
  "No order types yet. Add what baristas stamp, such as an espresso drink.": "لا أنواع طلبات بعد. أضف ما يمنح الباريستا عليه أختاماً، مثل مشروب إسبريسو.",
} as const;

const STAMPS = {
  en: { one: "{n} stamp", other: "{n} stamps" },
  ar: { zero: "بلا أختام", one: "ختم واحد", two: "ختمان", few: "{n} أختام", many: "{n} ختماً", other: "{n} ختم" },
};

type Save = (method: "PATCH" | "PUT" | "POST", path: string, body: unknown) => Promise<boolean>;

function CafeNameForm({ name, save }: { name: string; save: Save }) {
  const t = useT(AR);
  const [value, setValue] = useState(name);
  const { pending, error, fieldErrors, done, clearDone, submit } = useSubmit();
  return (
    <Form
      aria-labelledby="cafe-name-title"
      onChange={clearDone}
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => save("PATCH", "/api/cafe", { name: value }));
      }}
    >
      <h4 id="cafe-name-title">{t("Café name")}</h4>
      <FormError message={error} />
      <Field label={t("Name")} name="name" type="text" value={value} onChange={setValue} maxLength={120} error={fieldErrors.name} />
      <button type="submit" aria-disabled={pending || undefined}>
        {pending ? t("Saving…") : t("Save name")}
      </button>
      <Notice>{done ? t("Saved.") : null}</Notice>
    </Form>
  );
}

/** The café's Google review link, offered to every customer on the feedback page (AC 37); empty removes it. */
function ReviewLinkForm({ googleReviewUrl, save }: { googleReviewUrl: string | null; save: Save }) {
  const t = useT(AR);
  const [value, setValue] = useState(googleReviewUrl ?? "");
  const { pending, error, fieldErrors, done, clearDone, submit } = useSubmit();
  return (
    <Form
      aria-labelledby="review-link-title"
      onChange={clearDone}
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => save("PATCH", "/api/cafe", { googleReviewUrl: value }));
      }}
    >
      <h4 id="review-link-title">{t("Google review link")}</h4>
      <p className="hint">
        {t(
          'About two hours after a visit, each customer\'s card links to a feedback page. Every customer sees this link there, beside a private message to you. Find it in your Google Business Profile under "Ask for reviews".',
        )}
      </p>
      <FormError message={error} />
      <Field
        label={t("Review link")}
        name="googleReviewUrl"
        type="url"
        value={value}
        onChange={setValue}
        maxLength={500}
        optional
        hint={t("Leave it empty to show no review link.")}
        error={fieldErrors.googleReviewUrl}
      />
      <button type="submit" aria-disabled={pending || undefined}>
        {pending ? t("Saving…") : t("Save review link")}
      </button>
      <Notice>{done ? t("Saved.") : null}</Notice>
    </Form>
  );
}

export function ProgramForm({ program, save, unsaved }: { program: CafeSetup["program"]; save: Save; unsaved?: UnsavedChanges }) {
  const t = useT(AR);
  const lang = useLang();
  const [stamps, setStamps] = useState(program === null ? "" : String(program.stampsRequired));
  const [rewardEn, setRewardEn] = useState(program?.rewardNameEn ?? "");
  const [rewardAr, setRewardAr] = useState(program?.rewardNameAr ?? "");
  const [stampsError, setStampsError] = useState<Later<typeof AR> | undefined>(undefined);
  const { pending, error, fieldErrors, done, clearDone, submit } = useSubmit();
  return (
    <Form
      aria-labelledby="program-title"
      unsaved={unsaved}
      onChange={clearDone}
      className="card form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        const stampsRequired = parseWholeNumberInput(stamps);
        // Wrapped: a function given to a state setter is taken as an updater, not stored.
        setStampsError(() => (stampsRequired === null ? (say: Translate<typeof AR>) => say("Enter a whole number, such as 9.") : undefined));
        if (stampsRequired === null) {
          return;
        }
        void submit(() => save("PUT", "/api/cafe/program", { stampsRequired, rewardNameEn: rewardEn, rewardNameAr: rewardAr }));
      }}
    >
      <h4 id="program-title">{t("Loyalty program")}</h4>
      {program === null ? <p>{t("Set the program before baristas start giving stamps.")}</p> : null}
      <FormError message={error} />
      <Field
        label={t("Stamps for a reward")}
        name="stampsRequired"
        type="text"
        inputMode="numeric"
        value={stamps}
        onChange={setStamps}
        hint={t("1 to 50.")}
        error={stampsError?.(t, lang) ?? fieldErrors.stampsRequired}
      />
      <Field label={t("Reward (English)")} name="rewardNameEn" type="text" lang="en" value={rewardEn} onChange={setRewardEn} maxLength={80} error={fieldErrors.rewardNameEn} />
      <Field
        label={t("Reward (Arabic)")}
        name="rewardNameAr"
        type="text"
        lang="ar"
        value={rewardAr}
        onChange={setRewardAr}
        maxLength={80}
        error={fieldErrors.rewardNameAr}
      />
      <button type="submit" aria-disabled={pending || undefined}>
        {pending ? t("Saving…") : t("Save program")}
      </button>
      <Notice>{done ? t("Saved.") : null}</Notice>
    </Form>
  );
}

/** The café's minimum margin over cost, below which no campaign may discount (AC 35). */
function MarginForm({ minMarginPercent, save }: { minMarginPercent: number; save: Save }) {
  const t = useT(AR);
  const lang = useLang();
  const [value, setValue] = useState(String(minMarginPercent));
  const [invalid, setInvalid] = useState<Later<typeof AR> | undefined>(undefined);
  const { pending, error, fieldErrors, done, clearDone, submit } = useSubmit();
  return (
    <Form
      aria-labelledby="margin-title"
      onChange={clearDone}
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        const percent = parseWholeNumberInput(value);
        setInvalid(() => (percent === null || percent > 1000 ? (say: Translate<typeof AR>) => say("Enter a whole percentage from 0 to 1000, such as 30.") : undefined));
        if (percent !== null && percent <= 1000) {
          void submit(() => save("PATCH", "/api/cafe", { minMarginPercent: percent }));
        }
      }}
    >
      <h4 id="margin-title">{t("Minimum margin")}</h4>
      <FormError message={error} />
      <Field
        label={t("Minimum margin over cost (%)")}
        name="minMarginPercent"
        type="text"
        inputMode="numeric"
        value={value}
        onChange={setValue}
        hint={t(
          "Campaigns never sell an item for less than its cost plus this much: 30% keeps a drink that costs $1.00 at $1.30 or more. Running campaigns keep the margin they started with.",
        )}
        error={invalid?.(t, lang) ?? fieldErrors.minMarginPercent}
      />
      <button type="submit" aria-disabled={pending || undefined}>
        {pending ? t("Saving…") : t("Save margin")}
      </button>
      <Notice>{done ? t("Saved.") : null}</Notice>
    </Form>
  );
}

/**
 * The café's win-back offer (AC 36): what a regular who stopped coming gets off their next visit, if anything, and how
 * long before the same card can get it again.
 */
function WinBackForm({ winBack, save }: { winBack: WinBackSettings; save: Save }) {
  const t = useT(AR);
  const lang = useLang();
  const [kind, setKind] = useState<"none" | "percent" | "amount">(winBack.discount?.kind ?? "none");
  const [value, setValue] = useState(winBack.discount === null ? "" : winBack.discount.kind === "percent" ? String(winBack.discount.value) : centsToInput(winBack.discount.value));
  const [cooldown, setCooldown] = useState(String(winBack.cooldownDays));
  const [problems, setProblems] = useState<Record<string, Later<typeof AR>>>({});
  const { pending, error, fieldErrors, done, clearDone, submit } = useSubmit();
  return (
    <Form
      aria-labelledby="win-back-title"
      onChange={clearDone}
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        const amount = kind === "percent" ? parseWholeNumberInput(value) : kind === "amount" ? parseUsdInput(value) : null;
        const days = parseWholeNumberInput(cooldown);
        const invalid: Record<string, Later<typeof AR>> = {
          ...(kind !== "none" && (amount === null || amount < 1 || (kind === "percent" && amount > 100))
            ? { discount: kind === "percent" ? (say: Translate<typeof AR>) => say("Enter a whole percentage from 1 to 100.") : (say: Translate<typeof AR>) => say("Enter an amount in dollars, such as 0.50.") }
            : {}),
          ...(days === null || days < WIN_BACK_OFFER_DAYS || days > WIN_BACK_MAX_COOLDOWN_DAYS
            ? { cooldownDays: (say: Translate<typeof AR>) => say("Enter a whole number of days from {min} to {max}.", { min: WIN_BACK_OFFER_DAYS, max: WIN_BACK_MAX_COOLDOWN_DAYS }) }
            : {}),
        };
        setProblems(invalid);
        if (Object.keys(invalid).length > 0 || days === null) {
          return;
        }
        const body: WinBackSettings = { discount: kind === "none" || amount === null ? null : { kind, value: amount }, cooldownDays: days };
        void submit(() => save("PUT", "/api/cafe/win-back", body));
      }}
    >
      <h4 id="win-back-title">{t("Welcome-back offer")}</h4>
      <p className="hint">
        {t(
          "When a regular (3 visits or more) stays away much longer than usual, at least 2 weeks, their card offers this off their next visit, for {days} days, if they agreed to receive offers. It never takes an item below its minimum margin.",
          { days: WIN_BACK_OFFER_DAYS },
        )}
      </p>
      <FormError message={error} />
      <fieldset>
        <legend>{t("Discount")}</legend>
        <div className="choices">
          {(
            [
              ["none", "No offer"],
              ["percent", "Percent off"],
              ["amount", "Amount off each item"],
            ] as const
          ).map(([option, label]) => (
            <label key={option}>
              <input
                type="radio"
                name="win-back-kind"
                checked={kind === option}
                onChange={() => {
                  setKind(option);
                }}
              />{" "}
              {t(label)}
            </label>
          ))}
        </div>
        {kind === "none" ? null : (
          <Field
            label={kind === "percent" ? t("Percentage") : t("Amount (USD)")}
            name="winBackDiscount"
            type="text"
            inputMode={kind === "percent" ? "numeric" : "decimal"}
            value={value}
            onChange={setValue}
            hint={kind === "percent" ? t("A whole number, such as 15.") : t("Such as 0.50.")}
            error={problems.discount?.(t, lang) ?? fieldErrors["discount.value"]}
          />
        )}
      </fieldset>
      <Field
        label={t("Days before the same card can get it again")}
        name="cooldownDays"
        type="text"
        inputMode="numeric"
        value={cooldown}
        onChange={setCooldown}
        hint={t("At least {days}, how long an offer lasts. Offers already given keep their terms.", { days: WIN_BACK_OFFER_DAYS })}
        error={problems.cooldownDays?.(t, lang) ?? fieldErrors.cooldownDays}
      />
      <button type="submit" aria-disabled={pending || undefined}>
        {pending ? t("Saving…") : t("Save welcome-back offer")}
      </button>
      <Notice>{done ? t("Saved.") : null}</Notice>
    </Form>
  );
}

/** Adds an order type, or edits one when `orderType` is given; `onDone` closes the edit, saying whether it was saved. */
export function OrderTypeForm({
  orderType,
  save,
  onDone,
  unsaved,
}: {
  orderType?: OrderType;
  save: Save;
  onDone?: (saved: boolean) => void;
  unsaved?: UnsavedChanges;
}) {
  const t = useT(AR);
  const lang = useLang();
  const [nameEn, setNameEn] = useState(orderType?.nameEn ?? "");
  const [nameAr, setNameAr] = useState(orderType?.nameAr ?? "");
  const [price, setPrice] = useState(orderType === undefined ? "" : centsToInput(orderType.priceCents));
  const [cost, setCost] = useState(orderType === undefined ? "" : centsToInput(orderType.costCents));
  const [stamps, setStamps] = useState(String(orderType?.stampsEarned ?? 1));
  const [active, setActive] = useState(orderType?.active ?? true);
  const [amountErrors, setAmountErrors] = useState<Record<string, Later<typeof AR>>>({});
  const { pending, error, fieldErrors, done, clearDone, submit } = useSubmit();
  const titleId = orderType === undefined ? "new-order-type-title" : `order-type-${orderType.id}-title`;

  return (
    <Form
      aria-labelledby={titleId}
      unsaved={unsaved}
      onChange={clearDone}
      className={orderType === undefined ? "form-grid add-form" : "form-grid"}
      onSubmit={(event) => {
        event.preventDefault();
        const priceCents = parseUsdInput(price);
        const costCents = parseUsdInput(cost);
        const stampsEarned = parseWholeNumberInput(stamps);
        const invalid = {
          ...(priceCents === null ? { priceCents: (say: Translate<typeof AR>) => say("Enter a price in dollars up to 1,000,000, such as 2.50.") } : {}),
          ...(costCents === null ? { costCents: (say: Translate<typeof AR>) => say("Enter a cost in dollars up to 1,000,000, such as 0.70.") } : {}),
          ...(stampsEarned === null ? { stampsEarned: (say: Translate<typeof AR>) => say("Enter a whole number, such as 1.") } : {}),
        };
        setAmountErrors(invalid);
        if (priceCents === null || costCents === null || stampsEarned === null) {
          return;
        }
        const body = { nameEn, nameAr, priceCents, costCents, stampsEarned, active };
        void submit(() =>
          orderType === undefined ? save("POST", "/api/cafe/order-types", body) : save("PATCH", `/api/cafe/order-types/${orderType.id}`, body),
        ).then((result) => {
          if (result.ok && result.value) {
            onDone?.(true);
            if (orderType === undefined) {
              setNameEn("");
              setNameAr("");
              setPrice("");
              setCost("");
              setStamps("1");
            }
          }
        });
      }}
    >
      <h4 id={titleId}>
        {orderType === undefined ? t("Add an order type") : t("Edit {name}", { name: lang === "ar" ? orderType.nameAr : orderType.nameEn })}
      </h4>
      <FormError message={error} />
      <Field label={t("Name (English)")} name="nameEn" type="text" lang="en" value={nameEn} onChange={setNameEn} maxLength={60} error={fieldErrors.nameEn} />
      <Field label={t("Name (Arabic)")} name="nameAr" type="text" lang="ar" value={nameAr} onChange={setNameAr} maxLength={60} error={fieldErrors.nameAr} />
      <Field
        label={t("Price (USD)")}
        name="price"
        type="text"
        inputMode="decimal"
        value={price}
        onChange={setPrice}
        error={amountErrors.priceCents?.(t, lang) ?? fieldErrors.priceCents}
      />
      <Field
        label={t("Cost to make (USD)")}
        name="cost"
        type="text"
        inputMode="decimal"
        value={cost}
        onChange={setCost}
        hint={t("What one costs you in ingredients and cup. Offers never go below cost.")}
        error={amountErrors.costCents?.(t, lang) ?? fieldErrors.costCents}
      />
      <Field
        label={t("Stamps earned")}
        name="stampsEarned"
        type="text"
        inputMode="numeric"
        value={stamps}
        onChange={setStamps}
        hint={t("0 to 10.")}
        error={amountErrors.stampsEarned?.(t, lang) ?? fieldErrors.stampsEarned}
      />
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => {
              setActive(event.target.checked);
            }}
          />{" "}
          {t("On sale (shown at the counter)")}
        </label>
      </div>
      <div className="actions">
        <button type="submit" aria-disabled={pending || undefined}>
          {pending ? t("Saving…") : orderType === undefined ? t("Add order type") : t("Save changes")}
        </button>
        {onDone === undefined || orderType === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              onDone(false);
            }}
          >
            {t("Cancel")}
          </button>
        )}
      </div>
      {/* An edit closes when saved, so its row says so instead (OrderTypeItem). */}
      {orderType === undefined ? <Notice>{done ? t("Saved.") : null}</Notice> : null}
    </Form>
  );
}

function OrderTypeItem({ orderType, save }: { orderType: OrderType; save: Save }) {
  const t = useT(AR);
  const lang = useLang();
  const [editing, setEditing] = useState(false);
  /** The edit just closed was saved: the row says so, next to where focus lands. */
  const [saved, setSaved] = useState(false);
  const item = useFocusOnChange<HTMLLIElement>(editing);
  // The same keyed Notice in both views of the row, so it stays in the page while the edit is open and its "Saved."
  // is announced when the edit closes (a region added together with its text often is not).
  const notice = <Notice key="saved">{saved ? t("Saved.") : null}</Notice>;
  if (editing) {
    return (
      <li ref={item}>
        <OrderTypeForm
          orderType={orderType}
          save={save}
          onDone={(wasSaved) => {
            setSaved(wasSaved);
            setEditing(false);
          }}
        />
        {notice}
      </li>
    );
  }
  return (
    <li ref={item} className="row">
      <span className="row-main">
        {/* Both names: the page's language first, the other marked as such. */}
        {lang === "ar" ? (
          <>
            <strong>{orderType.nameAr}</strong>{" "}
            <span lang="en" dir="ltr">
              {orderType.nameEn}
            </span>
          </>
        ) : (
          <>
            <strong>{orderType.nameEn}</strong>{" "}
            <span lang="ar" dir="rtl">
              {orderType.nameAr}
            </span>
          </>
        )}
        {orderType.active ? null : (
          <>
            {" "}
            <span className="badge">
              <span className="visually-hidden">{t("· ")}</span>
              {t("not on sale")}
            </span>
          </>
        )}
        <span className="row-meta">
          {t("{price} · cost {cost} · {stamps}", {
            price: formatUsd(orderType.priceCents, "en"),
            cost: formatUsd(orderType.costCents, "en"),
            stamps: plural(lang, STAMPS, orderType.stampsEarned),
          })}
        </span>
      </span>
      <button
        type="button"
        aria-label={t("Edit {name}", { name: lang === "ar" ? orderType.nameAr : orderType.nameEn })}
        onClick={() => {
          setSaved(false);
          setEditing(true);
        }}
      >
        {t("Edit")}
      </button>
      {notice}
    </li>
  );
}

/** The QR customers scan at the counter to get a card (AC 4), for printing; replacing it retires the old one. */
function SignupQr() {
  const t = useT(AR);
  const [state, setLink, retry] = useApiData("/api/cafe/join", joinLinkSchema);
  const { pending, error, submit } = useSubmit();
  if (state.status !== "loaded") {
    return <PageStatus state={state} onRetry={retry} />;
  }
  const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(state.data.joinUrl, { border: 4 }))}`;
  return (
    <section aria-labelledby="signup-qr-title" className="card">
      <h4 id="signup-qr-title" tabIndex={-1} data-focus-after-change>
        {t("Customer signup QR")}
      </h4>
      <p className="hint">{t("Print this and put it at the counter. Customers scan it to get their loyalty card.")}</p>
      <div className="signup-qr-box">
        <img className="signup-qr" src={qr} alt={t("QR code customers scan to get a loyalty card")} width={200} height={200} />
        <p className="link" dir="ltr">
          {state.data.joinUrl}
        </p>
      </div>
      {/* The printable sheet (D6), on its own page: the café's name, the code at about 8 cm, both languages. */}
      <p>
        <a className="action-link" href="/cafe/print-qr">
          {t("Print")}
        </a>
      </p>
      <FormError message={error} />
      <p className="hint">{t("Replace the code only if the printed one was misused: the old one stops working at once.")}</p>
      <ConfirmButton
        label={t("Replace code")}
        confirmLabel={t("Yes, replace the code")}
        pending={pending}
        onConfirm={() => {
          void submit(() => apiRequest("POST", "/api/cafe/join/rotate", joinLinkSchema)).then((result) => {
            if (result.ok) {
              setLink(result.value);
            }
          });
        }}
      />
    </section>
  );
}

/**
 * The Café page's sections, in order, as the in-page list links to them. The café's name is "Name", not "Café": the
 * page's own region and heading are "Café", and a section of the same name would repeat it (nested landmarks and the
 * list's first link).
 */
const SECTIONS = [
  ["cafe", "Name"],
  ["program", "Program"],
  ["menu", "Menu"],
  ["offers", "Offers and welcome-back"],
  ["signup", "Signup and reviews"],
] as const;

function SettingsSection({ id, title, children }: { id: (typeof SECTIONS)[number][0]; title: (typeof SECTIONS)[number][1]; children: ReactNode }) {
  const t = useT(AR);
  return (
    <section id={id} aria-labelledby={`${id}-section-title`} className="section settings-section">
      <h3 id={`${id}-section-title`} className="section-title">
        {t(title)}
      </h3>
      <div className="stack">{children}</div>
    </section>
  );
}

/** `/cafe`: the café's name, loyalty program, menu, offers and signup, in sections (AC 1). */
export function CafePage() {
  const t = useT(AR);
  const [state, setSetup, retry] = useApiData("/api/cafe", cafeSetupSchema);
  if (state.status !== "loaded") {
    return <PageStatus state={state} onRetry={retry} />;
  }
  const setup = state.data;

  // Each form says "Saved." next to its own button (useSubmit's `done`), where the owner is looking.
  const save: Save = async (method, path, body) => {
    setSetup(await apiRequest(method, path, cafeSetupSchema, body));
    return true;
  };

  return (
    <section aria-labelledby="cafe-page-title" className="cafe-settings">
      <h2 id="cafe-page-title">{t("Café")}</h2>
      <p className="page-intro">{t("Your program, menu and offers. Each part saves on its own.")}</p>
      <nav aria-label={t("Sections of this page")}>
        <ul className="section-list">
          {SECTIONS.map(([id, title]) => (
            <li key={id}>
              <a href={`#${id}`}>{t(title)}</a>
            </li>
          ))}
        </ul>
      </nav>
      {/* One section per part of the café, each card full width under the one before (never side by side). */}
      <SettingsSection id="cafe" title="Name">
        <CafeNameForm name={setup.cafe.name} save={save} />
      </SettingsSection>
      <SettingsSection id="program" title="Program">
        <ProgramForm program={setup.program} save={save} />
      </SettingsSection>
      <SettingsSection id="menu" title="Menu">
        <div className="card">
          {setup.orderTypes.length === 0 ? (
            <p className="empty">{t("No order types yet. Add what baristas stamp, such as an espresso drink.")}</p>
          ) : (
            <ul className="items">
              {setup.orderTypes.map((orderType) => (
                <OrderTypeItem key={orderType.id} orderType={orderType} save={save} />
              ))}
            </ul>
          )}
          <OrderTypeForm save={save} />
        </div>
      </SettingsSection>
      <SettingsSection id="offers" title="Offers and welcome-back">
        <MarginForm minMarginPercent={setup.cafe.minMarginPercent} save={save} />
        <WinBackForm winBack={setup.cafe.winBack} save={save} />
      </SettingsSection>
      <SettingsSection id="signup" title="Signup and reviews">
        <SignupQr />
        <ReviewLinkForm googleReviewUrl={setup.cafe.googleReviewUrl} save={save} />
      </SettingsSection>
    </section>
  );
}
