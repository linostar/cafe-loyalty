import {
  cafeSetupSchema,
  campaignsSchema,
  formatUsd,
  keepsMargin,
  marginFloorCents,
  unitDiscountCents,
  type Campaign,
  type CampaignCreate,
  type DiscountKind,
  type Lang,
  type OrderType,
} from "@cafe-loyalty/shared";
import { useEffect, useId, useState, type ReactNode } from "react";
import { apiRequest, isStale } from "./api.js";
import { ConfirmButton, Field, Form, FormError, Notice, useFocusWhenInvalid, useSubmit } from "./forms.js";
import { dateFormat, useLang, useT, type Translate, type Later, useSay } from "./i18n.js";
import { centsToInput, parseUsdInput, parseWholeNumberInput } from "./money-input.js";
import { PageStatus, useApiData } from "./session.js";

const AR = {
  "{value}% off": "خصم {value}%",
  "{amount} off": "خصم {amount}",
  "a removed order type": "نوع طلب محذوف",
  ", ": "، ",
  "{days}, {start} to {end}: {discount} {names}": "{days}، من {start} إلى {end}: {discount} على {names}",
  "Pick at least one day.": "اختر يوماً واحداً على الأقل.",
  "Enter a start time, such as 15:00.": "أدخل وقت البدء، مثل 15:00.",
  "End after the start, on the same day.": "اجعل النهاية بعد البداية، في اليوم نفسه.",
  "Enter a whole percentage from 1 to 100.": "أدخل نسبة مئوية صحيحة من 1 إلى 100.",
  "Enter an amount in dollars, such as 0.50.": "أدخل مبلغاً بالدولار، مثل 0.50.",
  "Pick at least one order type.": "اختر نوع طلب واحداً على الأقل.",
  "New campaign": "حملة جديدة",
  "Such as Quiet afternoons.": "مثل Quiet afternoons.",
  "Such as عصر هادئ.": "مثل عصر هادئ.",
  Days: "الأيام",
  "Every day": "كل يوم",
  "Monday to Friday": "من الاثنين إلى الجمعة",
  "Saturday and Sunday": "السبت والأحد",
  "Starts at": "يبدأ عند",
  "Ends at": "ينتهي عند",
  "Café time. Use 00:00 to run until midnight.": "بتوقيت المقهى. استخدم 00:00 لتستمر حتى منتصف الليل.",
  Discount: "الخصم",
  "Percent off": "خصم بنسبة مئوية",
  "Amount off each item": "خصم مبلغ عن كل صنف",
  "Amount off (USD)": "مبلغ الخصم (بالدولار)",
  "A whole number, such as 20. The discount rounds down to the cent, in your favour.": "عدد صحيح، مثل 20. يُقرَّب الخصم نزولاً إلى السنت، لصالحك.",
  "Such as 0.50.": "مثل 0.50.",
  "Order types": "أنواع الطلبات",
  "Your minimum margin is {margin}% over cost (Café page): a campaign that takes a picked order type below its floor is refused.":
    "الحد الأدنى لهامش ربحك {margin}% فوق التكلفة (صفحة المقهى): تُرفض أي حملة تُنزل نوع طلب مختاراً دون حدّه الأدنى.",
  "No order types on sale. Add some on the Café page first.": "لا أنواع طلبات معروضة للبيع. أضف بعضها من صفحة المقهى أولاً.",
  "{name}: {price} (floor {floor})": "{name}: {price} (الحد الأدنى {floor})",
  "{name}: {price}, {after} with the discount (floor {floor})": "{name}: {price}، و{after} مع الخصم (الحد الأدنى {floor})",
  "Below its floor: lower the discount or leave it out.": "دون حدّه الأدنى: خفّض الخصم أو استبعده.",
  "Start campaign": "بدء الحملة",
  "Some order types you picked would sell below their floor. Lower the discount, or leave them out.":
    "بعض أنواع الطلبات التي اخترتها ستُباع دون حدّها الأدنى. خفّض الخصم، أو استبعدها.",
  "Saved. Counter phones pick up the change within 5 minutes.": "تم الحفظ. تلتقط هواتف الكاونتر التغيير خلال 5 دقائق.",
  Campaigns: "الحملات",
  "A campaign takes money off chosen order types at quiet hours. The counter gives the discount to every loyalty card holder.":
    "تخصم الحملة من سعر أنواع طلبات مختارة في ساعات الهدوء. يمنح الكاونتر الخصم لكل حامل بطاقة ولاء.",
  Running: "جارية",
  "No campaigns running. Start one below for the hours the busy and quiet hours show as quiet.":
    "لا حملات جارية. ابدأ حملة أدناه للساعات التي تظهرها ساعات الذروة والهدوء هادئة.",
  running: "جارية",
  "End {name}": "إنهاء {name}",
  "Yes, end {name}": "نعم، أنهِ {name}",
  Ended: "منتهية",
  ended: "منتهية",
  "Start again": "البدء من جديد",
  "Start again {name}": "البدء من جديد {name}",
} as const;

type T = Translate<typeof AR>;

/** Monday to Sunday (5 to 11 January 2026), for the days' names in each language. */
const WEEK = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2026, 0, 5 + index)));

type Change = (method: "POST", path: string, body?: unknown) => Promise<void>;

/** Quick picks for the days, Monday (1) to Sunday (7). */
const DAY_PRESETS = [
  ["Every day", [1, 2, 3, 4, 5, 6, 7]],
  ["Monday to Friday", [1, 2, 3, 4, 5]],
  ["Saturday and Sunday", [6, 7]],
] as const;

/** "15:00" -> 900; "00:00" as an end means midnight, the end of the day. */
const minuteOf = (time: string, end: boolean): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null) {
    return null;
  }
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return end && minute === 0 ? 1440 : minute;
};

const timeOf = (minute: number): string => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

const discountText = (t: T, discount: Campaign["discount"]): string =>
  discount.kind === "percent" ? t("{value}% off", { value: discount.value }) : t("{amount} off", { amount: formatUsd(discount.value, "en") });

const nameOf = (lang: Lang, named: { nameEn: string; nameAr: string }): string => (lang === "ar" ? named.nameAr : named.nameEn);

/** "Mon, Tue, Wed, 15:00 to 17:00: 20% off Latte, Cake". */
function describe(t: T, lang: Lang, campaign: Campaign, orderTypes: readonly OrderType[]): string {
  const shortDay = dateFormat(lang, { weekday: "short", timeZone: "UTC" });
  const days = campaign.weekdays.map((day) => {
    const date = WEEK[day - 1];
    return date === undefined ? "?" : shortDay.format(date);
  });
  const names = campaign.orderTypeIds.map((id) => {
    const type = orderTypes.find((entry) => entry.id === id);
    return type === undefined ? t("a removed order type") : nameOf(lang, type);
  });
  return t("{days}, {start} to {end}: {discount} {names}", {
    days: days.join(t(", ")),
    start: timeOf(campaign.startsMinute),
    end: timeOf(campaign.endsMinute),
    discount: discountText(t, campaign.discount),
    names: names.join(t(", ")),
  });
}

/**
 * A checkbox and its label, marked invalid when `invalid`: the first day when none is picked, an order type below its
 * floor, the first picked order type when the order types are refused as a whole. `reported` is whether the last send
 * found a problem with its group (days, or order types), which is when it takes focus (useFocusWhenInvalid); an order
 * type that falls below its floor while the discount is typed is marked at once but leaves focus where it is.
 */
function Choice({
  invalid,
  reported,
  describedBy,
  checked,
  onChange,
  className,
  children,
}: {
  invalid: boolean;
  reported: boolean;
  describedBy: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const input = useFocusWhenInvalid(reported);
  return (
    <label className={className}>
      <input
        ref={input}
        type="checkbox"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />{" "}
      {children}
    </label>
  );
}

/** A labelled time of day; the hint says what an empty or midnight end means. Focused after a failed send, as a Field is. */
function TimeField({ label, value, onChange, hint, error }: { label: string; value: string; onChange: (value: string) => void; hint?: string; error?: string | undefined }) {
  const id = useId();
  const describedBy = [hint === undefined ? null : `${id}-hint`, error === undefined ? null : `${id}-error`].filter((part) => part !== null).join(" ");
  const input = useFocusWhenInvalid(error !== undefined);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={input}
        id={id}
        type="time"
        step={60}
        required
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === "" ? undefined : describedBy}
      />
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A new campaign (AC 35), empty or filled in from an ended one (`from`: Start again; campaigns are never edited). Each
 * order type shows its price after the discount against its margin floor, so the owner sees what the server would
 * refuse before sending it.
 */
function NewCampaignForm({ orderTypes, minMarginPercent, change, from }: { orderTypes: readonly OrderType[]; minMarginPercent: number; change: Change; from: Campaign | null }) {
  const t = useT(AR);
  const say = useSay(AR);
  const lang = useLang();
  const onSale = orderTypes.filter((type) => type.active);
  const [nameEn, setNameEn] = useState(from?.nameEn ?? "");
  const [nameAr, setNameAr] = useState(from?.nameAr ?? "");
  const [weekdays, setWeekdays] = useState<number[]>(from === null ? [] : [...from.weekdays]);
  const [starts, setStarts] = useState(from === null ? "15:00" : timeOf(from.startsMinute));
  const [ends, setEnds] = useState(from === null ? "17:00" : timeOf(from.endsMinute));
  const [kind, setKind] = useState<DiscountKind>(from?.discount.kind ?? "percent");
  const [value, setValue] = useState(from === null ? "" : from.discount.kind === "percent" ? String(from.discount.value) : centsToInput(from.discount.value));
  // Only the order types still on sale: one removed since is left out.
  const [chosen, setChosen] = useState<string[]>(from === null ? [] : from.orderTypeIds.filter((id) => onSale.some((type) => type.id === id)));
  const [problems, setProblems] = useState<Record<string, Later<typeof AR>>>({});
  const { pending, error, fieldErrors, done, clearDone, submit } = useSubmit();
  const discountValue = kind === "percent" ? parseWholeNumberInput(value) : parseUsdInput(value);
  const discount = discountValue === null || discountValue < 1 ? null : { kind, value: discountValue };
  const longDay = dateFormat(lang, { weekday: "long", timeZone: "UTC" });
  /** The last send found a problem with the order types as a whole: in the page's checks or in the server's answer. */
  const typesProblem = (problems.orderTypeIds ?? fieldErrors.orderTypeIds) !== undefined;
  const anyBelowFloor = discount !== null && onSale.some((type) => chosen.includes(type.id) && !keepsMargin(type.priceCents, type.costCents, discount, minMarginPercent));
  /** Where a problem with the order types as a whole is marked: the first picked one, or the first with none picked. */
  const firstTypeTarget = Math.max(0, onSale.findIndex((type) => chosen.includes(type.id)));

  return (
    <Form
      aria-labelledby="new-campaign-title"
      className="card"
      onChange={clearDone}
      onSubmit={(event) => {
        event.preventDefault();
        const startsMinute = minuteOf(starts, false);
        const endsMinute = minuteOf(ends, true);
        const invalid = {
          ...(weekdays.length === 0 ? { weekdays: (say: Translate<typeof AR>) => say("Pick at least one day.") } : {}),
          ...(startsMinute === null ? { startsMinute: (say: Translate<typeof AR>) => say("Enter a start time, such as 15:00.") } : {}),
          ...(endsMinute === null || (startsMinute !== null && endsMinute <= startsMinute) ? { endsMinute: (say: Translate<typeof AR>) => say("End after the start, on the same day.") } : {}),
          ...(discount === null || (kind === "percent" && discount.value > 100)
            ? { discount: kind === "percent" ? (say: Translate<typeof AR>) => say("Enter a whole percentage from 1 to 100.") : (say: Translate<typeof AR>) => say("Enter an amount in dollars, such as 0.50.") }
            : {}),
          ...(chosen.length === 0
            ? { orderTypeIds: (say: Translate<typeof AR>) => say("Pick at least one order type.") }
            : discount !== null && onSale.some((type) => chosen.includes(type.id) && !keepsMargin(type.priceCents, type.costCents, discount, minMarginPercent))
              ? { orderTypeIds: (say: Translate<typeof AR>) => say("Some order types you picked would sell below their floor. Lower the discount, or leave them out.") }
              : {}),
        };
        setProblems(invalid);
        if (Object.keys(invalid).length > 0 || discount === null || startsMinute === null || endsMinute === null) {
          return;
        }
        const body: CampaignCreate = { nameEn, nameAr, weekdays, startsMinute, endsMinute, discount, orderTypeIds: chosen };
        void submit(() => change("POST", "/api/campaigns", body)).then((result) => {
          if (result.ok) {
            setNameEn("");
            setNameAr("");
            setWeekdays([]);
            setValue("");
            setChosen([]);
          }
        });
      }}
    >
      <h3 id="new-campaign-title" tabIndex={-1}>
        {t("New campaign")}
      </h3>
      <FormError message={error} />
      <div className="form-grid">
        <Field
          label={t("Name (English)")}
          name="nameEn"
          type="text"
          lang="en"
          value={nameEn}
          onChange={setNameEn}
          maxLength={60}
          hint={t("Such as Quiet afternoons.")}
          error={fieldErrors.nameEn}
        />
        <Field
          label={t("Name (Arabic)")}
          name="nameAr"
          type="text"
          lang="ar"
          value={nameAr}
          onChange={setNameAr}
          maxLength={60}
          hint={t("Such as عصر هادئ.")}
          error={fieldErrors.nameAr}
        />
      </div>
      <fieldset aria-describedby={problems.weekdays === undefined ? undefined : "campaign-days-error"}>
        <legend>{t("Days")}</legend>
        <div className="actions">
          {DAY_PRESETS.map(([label, days]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                clearDone();
                setWeekdays([...days]);
              }}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div className="choices">
          {WEEK.map((day, index) => (
            <Choice
              key={day.getTime()}
              invalid={problems.weekdays !== undefined && index === 0}
              reported={problems.weekdays !== undefined}
              describedBy={problems.weekdays !== undefined && index === 0 ? "campaign-days-error" : undefined}
              checked={weekdays.includes(index + 1)}
              onChange={(checked) => {
                setWeekdays(checked ? [...weekdays, index + 1] : weekdays.filter((entry) => entry !== index + 1));
              }}
            >
              {longDay.format(day)}
            </Choice>
          ))}
        </div>
        {problems.weekdays === undefined ? null : (
          <p id="campaign-days-error" role="alert" className="field-error">
            {problems.weekdays(t, lang)}
          </p>
        )}
      </fieldset>
      <div className="form-grid">
        <TimeField label={t("Starts at")} value={starts} onChange={setStarts} error={problems.startsMinute?.(t, lang) ?? fieldErrors.startsMinute} />
        <TimeField
          label={t("Ends at")}
          value={ends}
          onChange={setEnds}
          hint={t("Café time. Use 00:00 to run until midnight.")}
          error={problems.endsMinute?.(t, lang) ?? fieldErrors.endsMinute}
        />
      </div>
      <fieldset>
        <legend>{t("Discount")}</legend>
        <div className="choices">
          {(["percent", "amount"] as const).map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="discount-kind"
                checked={kind === option}
                onChange={() => {
                  setKind(option);
                }}
              />{" "}
              {option === "percent" ? t("Percent off") : t("Amount off each item")}
            </label>
          ))}
        </div>
        <Field
          label={kind === "percent" ? t("Percent off") : t("Amount off (USD)")}
          name="discount"
          type="text"
          inputMode={kind === "percent" ? "numeric" : "decimal"}
          value={value}
          onChange={setValue}
          hint={kind === "percent" ? t("A whole number, such as 20. The discount rounds down to the cent, in your favour.") : t("Such as 0.50.")}
          error={problems.discount?.(t, lang) ?? fieldErrors["discount.value"]}
        />
      </fieldset>
      <fieldset aria-describedby={(problems.orderTypeIds ?? fieldErrors.orderTypeIds) === undefined ? "campaign-types-hint" : "campaign-types-hint campaign-types-error"}>
        <legend>{t("Order types")}</legend>
        <p id="campaign-types-hint" className="hint">
          {t("Your minimum margin is {margin}% over cost (Café page): a campaign that takes a picked order type below its floor is refused.", {
            margin: minMarginPercent,
          })}
        </p>
        {onSale.length === 0 ? <p>{t("No order types on sale. Add some on the Café page first.")}</p> : null}
        <ul className="choices-list">
          {onSale.map((type, index) => {
            const floor = marginFloorCents(type.costCents, minMarginPercent);
            const kept = discount === null || keepsMargin(type.priceCents, type.costCents, discount, minMarginPercent);
            const after = discount === null ? null : type.priceCents - unitDiscountCents(type.priceCents, discount);
            const prices = { name: nameOf(lang, type), price: formatUsd(type.priceCents, "en"), floor: formatUsd(floor, "en") };
            const belowFloor = !kept && chosen.includes(type.id);
            // A problem with the order types as a whole (none picked, or the server refusing them) marks the first
            // picked one (or the first, with none picked) unless a type below its floor already says where it is.
            const listFlag = typesProblem && !anyBelowFloor && index === firstTypeTarget;
            return (
              <li key={type.id}>
                <Choice
                  className="check"
                  invalid={belowFloor || listFlag}
                  reported={typesProblem}
                  describedBy={belowFloor ? `campaign-type-${type.id}-error` : listFlag ? "campaign-types-error" : undefined}
                  checked={chosen.includes(type.id)}
                  onChange={(checked) => {
                    setChosen(checked ? [...chosen, type.id] : chosen.filter((id) => id !== type.id));
                  }}
                >
                  {after === null
                    ? t("{name}: {price} (floor {floor})", prices)
                    : t("{name}: {price}, {after} with the discount (floor {floor})", { ...prices, after: formatUsd(after, "en") })}
                </Choice>
                {kept || !chosen.includes(type.id) ? null : (
                  <p id={`campaign-type-${type.id}-error`} className="field-error">
                    {t("Below its floor: lower the discount or leave it out.")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {(problems.orderTypeIds ?? fieldErrors.orderTypeIds) === undefined ? null : (
          <p id="campaign-types-error" role={problems.orderTypeIds === undefined ? undefined : "alert"} className="field-error">
            {problems.orderTypeIds?.(t, lang) ?? say(fieldErrors.orderTypeIds ?? "")}
          </p>
        )}
      </fieldset>
      <button type="submit" aria-disabled={pending || undefined}>
        {pending ? t("Saving…") : t("Start campaign")}
      </button>
      <Notice>{done ? t("Saved. Counter phones pick up the change within 5 minutes.") : null}</Notice>
    </Form>
  );
}

/** `/campaigns`: quiet-hour campaigns (AC 35), counted in the café's time zone and checked against the margin floor. */
export function CampaignsPage() {
  const t = useT(AR);
  const lang = useLang();
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setCampaigns, retryCampaigns] = useApiData("/api/campaigns", campaignsSchema, reloadKey);
  const [setup, , retrySetup] = useApiData("/api/cafe", cafeSetupSchema);
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  const ending = useSubmit();
  /** The ended campaign the new campaign form was last filled in from, and a count that makes a fresh form each time. */
  const [startAgain, setStartAgain] = useState<{ from: Campaign | null; count: number }>({ from: null, count: 0 });
  useEffect(() => {
    // The form is filled in afresh: focus moves to its heading, so the owner reads on from there.
    if (startAgain.count > 0) {
      document.getElementById("new-campaign-title")?.focus();
    }
  }, [startAgain]);
  // Only the café's setup holds the page back. The campaigns' own load (and a reload after a stale end) shows its state
  // in place of the lists, so the new campaign form, and anything typed into it, stays.
  if (setup.status !== "loaded") {
    return <PageStatus state={setup} onRetry={retrySetup} />;
  }
  const { orderTypes, cafe } = setup.data;
  const campaigns = state.status === "loaded" ? state.data : null;
  const change: Change = async (method, path, body) => {
    setCampaigns(await apiRequest(method, path, campaignsSchema, body));
  };
  // Ending a campaign is said under the page's heading, where focus goes once it is ended; the form that starts one
  // says so next to its own button.
  const changeAndSay: Change = async (method, path, body) => {
    setNotice(null);
    await change(method, path, body);
    setNotice(() => (say: Translate<typeof AR>) => say("Saved. Counter phones pick up the change within 5 minutes."));
  };

  return (
    <section aria-labelledby="campaigns-page-title">
      <h2 id="campaigns-page-title" tabIndex={-1} data-focus-after-change>
        {t("Campaigns")}
      </h2>
      <p className="page-intro">
        {t("A campaign takes money off chosen order types at quiet hours. The counter gives the discount to every loyalty card holder.")}
      </p>
      <Notice>{notice === null ? null : notice(t, lang)}</Notice>
      <FormError message={ending.error} />
      <h3>{t("Running")}</h3>
      {campaigns === null ? (
        <PageStatus state={state} onRetry={retryCampaigns} />
      ) : campaigns.running.length === 0 ? (
        <p className="empty">{t("No campaigns running. Start one below for the hours the busy and quiet hours show as quiet.")}</p>
      ) : (
        <ul className="items">
          {campaigns.running.map((campaign) => (
            <li key={campaign.id} className="row">
              <span className="row-main">
                <strong>{nameOf(lang, campaign)}</strong>: {describe(t, lang, campaign, orderTypes)} <span className="badge badge-success">{t("running")}</span>
              </span>
              <ConfirmButton
                label={t("End {name}", { name: nameOf(lang, campaign) })}
                confirmLabel={t("Yes, end {name}", { name: nameOf(lang, campaign) })}
                pending={ending.pending}
                onConfirm={() => {
                  void ending.submit(() => changeAndSay("POST", `/api/campaigns/${campaign.id}/end`)).then((result) => {
                    if (!result.ok && isStale(result.error)) {
                      setReloadKey((key) => key + 1);
                    }
                  });
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <NewCampaignForm key={startAgain.count} from={startAgain.from} orderTypes={orderTypes} minMarginPercent={cafe.minMarginPercent} change={change} />
      {campaigns === null || campaigns.ended.length === 0 ? null : (
        <>
          <h3>{t("Ended")}</h3>
          <ul className="items">
            {campaigns.ended.map((campaign) => (
              <li key={campaign.id} className="row">
                <span className="row-main">
                  <strong>{nameOf(lang, campaign)}</strong>: {describe(t, lang, campaign, orderTypes)} <span className="badge">{t("ended")}</span>
                </span>
                {/* A short visible label; the name adds the campaign (WCAG 2.5.3: it starts with what is shown). */}
                <button
                  type="button"
                  aria-label={t("Start again {name}", { name: nameOf(lang, campaign) })}
                  onClick={() => {
                    setStartAgain(({ count }) => ({ from: campaign, count: count + 1 }));
                  }}
                >
                  {t("Start again")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
