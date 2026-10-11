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
import { useState } from "react";
import { renderSVG } from "uqr";
import { apiRequest } from "./api.js";
import { ConfirmButton, Field, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
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
  "Win-back offer": "عرض الاسترجاع",
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
  "Save win-back offer": "حفظ عرض الاسترجاع",
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
  "Replace the code only if the printed one was misused: the old one stops working at once.": "لا تستبدل الرمز إلا إذا أُسيء استخدام الرمز المطبوع: يتوقف الرمز القديم عن العمل فوراً.",
  "Replace code": "استبدال الرمز",
  "Yes, replace the code": "نعم، استبدل الرمز",
  Café: "المقهى",
  "Your café's name, loyalty program, margin, win-back offer, Google review link and menu.": "اسم مقهاك، وبرنامج الولاء، والهامش، وعرض الاسترجاع، ورابط التقييم على Google، وقائمة الأصناف.",
  "Order types": "أنواع الطلبات",
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
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="cafe-name-title"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => save("PATCH", "/api/cafe", { name: value }));
      }}
    >
      <h3 id="cafe-name-title">{t("Café name")}</h3>
      <FormError message={error} />
      <Field label={t("Name")} name="name" type="text" value={value} onChange={setValue} maxLength={120} error={fieldErrors.name} />
      <button type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Save name")}
      </button>
    </form>
  );
}

/** The café's Google review link, offered to every customer on the feedback page (AC 37); empty removes it. */
function ReviewLinkForm({ googleReviewUrl, save }: { googleReviewUrl: string | null; save: Save }) {
  const t = useT(AR);
  const [value, setValue] = useState(googleReviewUrl ?? "");
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="review-link-title"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => save("PATCH", "/api/cafe", { googleReviewUrl: value }));
      }}
    >
      <h3 id="review-link-title">{t("Google review link")}</h3>
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
      <button type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Save review link")}
      </button>
    </form>
  );
}

function ProgramForm({ program, save }: { program: CafeSetup["program"]; save: Save }) {
  const t = useT(AR);
  const [stamps, setStamps] = useState(program === null ? "" : String(program.stampsRequired));
  const [rewardEn, setRewardEn] = useState(program?.rewardNameEn ?? "");
  const [rewardAr, setRewardAr] = useState(program?.rewardNameAr ?? "");
  const [stampsError, setStampsError] = useState<string | undefined>(undefined);
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="program-title"
      className="card form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        const stampsRequired = parseWholeNumberInput(stamps);
        setStampsError(stampsRequired === null ? t("Enter a whole number, such as 9.") : undefined);
        if (stampsRequired === null) {
          return;
        }
        void submit(() => save("PUT", "/api/cafe/program", { stampsRequired, rewardNameEn: rewardEn, rewardNameAr: rewardAr }));
      }}
    >
      <h3 id="program-title">{t("Loyalty program")}</h3>
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
        error={stampsError ?? fieldErrors.stampsRequired}
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
      <button type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Save program")}
      </button>
    </form>
  );
}

/** The café's minimum margin over cost, below which no campaign may discount (AC 35). */
function MarginForm({ minMarginPercent, save }: { minMarginPercent: number; save: Save }) {
  const t = useT(AR);
  const [value, setValue] = useState(String(minMarginPercent));
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="margin-title"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        const percent = parseWholeNumberInput(value);
        setInvalid(percent === null || percent > 1000 ? t("Enter a whole percentage from 0 to 1000, such as 30.") : undefined);
        if (percent !== null && percent <= 1000) {
          void submit(() => save("PATCH", "/api/cafe", { minMarginPercent: percent }));
        }
      }}
    >
      <h3 id="margin-title">{t("Minimum margin")}</h3>
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
        error={invalid ?? fieldErrors.minMarginPercent}
      />
      <button type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Save margin")}
      </button>
    </form>
  );
}

/**
 * The café's win-back offer (AC 36): what a regular who stopped coming gets off their next visit, if anything, and how
 * long before the same card can get it again.
 */
function WinBackForm({ winBack, save }: { winBack: WinBackSettings; save: Save }) {
  const t = useT(AR);
  const [kind, setKind] = useState<"none" | "percent" | "amount">(winBack.discount?.kind ?? "none");
  const [value, setValue] = useState(winBack.discount === null ? "" : winBack.discount.kind === "percent" ? String(winBack.discount.value) : centsToInput(winBack.discount.value));
  const [cooldown, setCooldown] = useState(String(winBack.cooldownDays));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="win-back-title"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        const amount = kind === "percent" ? parseWholeNumberInput(value) : kind === "amount" ? parseUsdInput(value) : null;
        const days = parseWholeNumberInput(cooldown);
        const invalid: Record<string, string> = {
          ...(kind !== "none" && (amount === null || amount < 1 || (kind === "percent" && amount > 100))
            ? { discount: kind === "percent" ? t("Enter a whole percentage from 1 to 100.") : t("Enter an amount in dollars, such as 0.50.") }
            : {}),
          ...(days === null || days < WIN_BACK_OFFER_DAYS || days > WIN_BACK_MAX_COOLDOWN_DAYS
            ? { cooldownDays: t("Enter a whole number of days from {min} to {max}.", { min: WIN_BACK_OFFER_DAYS, max: WIN_BACK_MAX_COOLDOWN_DAYS }) }
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
      <h3 id="win-back-title">{t("Win-back offer")}</h3>
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
            error={problems.discount ?? fieldErrors["discount.value"]}
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
        error={problems.cooldownDays ?? fieldErrors.cooldownDays}
      />
      <button type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Save win-back offer")}
      </button>
    </form>
  );
}

/** Adds an order type, or edits one when `orderType` is given. */
function OrderTypeForm({ orderType, save, onDone }: { orderType?: OrderType; save: Save; onDone?: () => void }) {
  const t = useT(AR);
  const lang = useLang();
  const [nameEn, setNameEn] = useState(orderType?.nameEn ?? "");
  const [nameAr, setNameAr] = useState(orderType?.nameAr ?? "");
  const [price, setPrice] = useState(orderType === undefined ? "" : centsToInput(orderType.priceCents));
  const [cost, setCost] = useState(orderType === undefined ? "" : centsToInput(orderType.costCents));
  const [stamps, setStamps] = useState(String(orderType?.stampsEarned ?? 1));
  const [active, setActive] = useState(orderType?.active ?? true);
  const [amountErrors, setAmountErrors] = useState<Record<string, string>>({});
  const { pending, error, fieldErrors, submit } = useSubmit();
  const titleId = orderType === undefined ? "new-order-type-title" : `order-type-${orderType.id}-title`;

  return (
    <form
      aria-labelledby={titleId}
      className={orderType === undefined ? "form-grid add-form" : "form-grid"}
      onSubmit={(event) => {
        event.preventDefault();
        const priceCents = parseUsdInput(price);
        const costCents = parseUsdInput(cost);
        const stampsEarned = parseWholeNumberInput(stamps);
        const invalid = {
          ...(priceCents === null ? { priceCents: t("Enter a price in dollars up to 1,000,000, such as 2.50.") } : {}),
          ...(costCents === null ? { costCents: t("Enter a cost in dollars up to 1,000,000, such as 0.70.") } : {}),
          ...(stampsEarned === null ? { stampsEarned: t("Enter a whole number, such as 1.") } : {}),
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
            onDone?.();
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
        error={amountErrors.priceCents ?? fieldErrors.priceCents}
      />
      <Field
        label={t("Cost to make (USD)")}
        name="cost"
        type="text"
        inputMode="decimal"
        value={cost}
        onChange={setCost}
        hint={t("What one costs you in ingredients and cup. Offers never go below cost.")}
        error={amountErrors.costCents ?? fieldErrors.costCents}
      />
      <Field
        label={t("Stamps earned")}
        name="stampsEarned"
        type="text"
        inputMode="numeric"
        value={stamps}
        onChange={setStamps}
        hint={t("0 to 10.")}
        error={amountErrors.stampsEarned ?? fieldErrors.stampsEarned}
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
        <button type="submit" disabled={pending}>
          {pending ? t("Saving…") : orderType === undefined ? t("Add order type") : t("Save changes")}
        </button>
        {onDone === undefined || orderType === undefined ? null : (
          <button type="button" onClick={onDone}>
            {t("Cancel")}
          </button>
        )}
      </div>
    </form>
  );
}

function OrderTypeItem({ orderType, save }: { orderType: OrderType; save: Save }) {
  const t = useT(AR);
  const lang = useLang();
  const [editing, setEditing] = useState(false);
  const item = useFocusOnChange<HTMLLIElement>(editing);
  if (editing) {
    return (
      <li ref={item}>
        <OrderTypeForm
          orderType={orderType}
          save={save}
          onDone={() => {
            setEditing(false);
          }}
        />
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
          setEditing(true);
        }}
      >
        {t("Edit")}
      </button>
    </li>
  );
}

/** The QR customers scan at the counter to get a card (AC 4), for printing; replacing it retires the old one. */
function SignupQr() {
  const t = useT(AR);
  const [state, setLink] = useApiData("/api/cafe/join", joinLinkSchema);
  const { pending, error, submit } = useSubmit();
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(state.data.joinUrl, { border: 4 }))}`;
  return (
    <section aria-labelledby="signup-qr-title" className="card">
      <h3 id="signup-qr-title" tabIndex={-1} data-focus-after-change>
        {t("Customer signup QR")}
      </h3>
      <p className="hint">{t("Print this and put it at the counter. Customers scan it to get their loyalty card.")}</p>
      <div className="signup-qr-box">
        <img className="signup-qr" src={qr} alt={t("QR code customers scan to get a loyalty card")} width={200} height={200} />
        <p className="link" dir="ltr">
          {state.data.joinUrl}
        </p>
      </div>
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

/** `/cafe`: the café's name, loyalty program and order types (AC 1). */
export function CafePage() {
  const t = useT(AR);
  const [state, setSetup] = useApiData("/api/cafe", cafeSetupSchema);
  const lang = useLang();
  const [saved, setSaved] = useState<Later<typeof AR> | null>(null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const setup = state.data;

  const save: Save = async (method, path, body) => {
    setSaved(null);
    setSetup(await apiRequest(method, path, cafeSetupSchema, body));
    setSaved(() => (say: Translate<typeof AR>) => say("Saved."));
    return true;
  };

  return (
    <section aria-labelledby="cafe-page-title">
      <h2 id="cafe-page-title">{t("Café")}</h2>
      <p className="page-intro">{t("Your café's name, loyalty program, margin, win-back offer, Google review link and menu.")}</p>
      {saved === null ? null : <Notice>{saved(t, lang)}</Notice>}
      <div className="card-grid">
        <CafeNameForm name={setup.cafe.name} save={save} />
        <SignupQr />
        <ProgramForm program={setup.program} save={save} />
        <MarginForm minMarginPercent={setup.cafe.minMarginPercent} save={save} />
        <WinBackForm winBack={setup.cafe.winBack} save={save} />
        <ReviewLinkForm googleReviewUrl={setup.cafe.googleReviewUrl} save={save} />
      </div>
      <section aria-labelledby="order-types-title" className="card">
        <h3 id="order-types-title">{t("Order types")}</h3>
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
      </section>
    </section>
  );
}
