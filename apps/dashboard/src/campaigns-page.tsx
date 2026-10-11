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
import { useId, useState } from "react";
import { apiRequest, isStale } from "./api.js";
import { ConfirmButton, Field, FormError, Notice, useSubmit } from "./forms.js";
import { dateFormat, useLang, useT, type Translate, type Later, useSay } from "./i18n.js";
import { parseUsdInput, parseWholeNumberInput } from "./money-input.js";
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
  Days: "الأيام",
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
} as const;

type T = Translate<typeof AR>;

/** Monday to Sunday (5 to 11 January 2026), for the days' names in each language. */
const WEEK = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2026, 0, 5 + index)));

type Change = (method: "POST", path: string, body?: unknown) => Promise<void>;

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

/** A labelled time of day; the hint says what an empty or midnight end means. */
function TimeField({ label, value, onChange, hint, error }: { label: string; value: string; onChange: (value: string) => void; hint?: string; error?: string | undefined }) {
  const id = useId();
  const describedBy = [hint === undefined ? null : `${id}-hint`, error === undefined ? null : `${id}-error`].filter((part) => part !== null).join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
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
 * A new campaign (AC 35). Each order type shows its price after the discount against its margin floor, so the owner
 * sees what the server would refuse before sending it.
 */
function NewCampaignForm({ orderTypes, minMarginPercent, change }: { orderTypes: readonly OrderType[]; minMarginPercent: number; change: Change }) {
  const t = useT(AR);
  const say = useSay(AR);
  const lang = useLang();
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [starts, setStarts] = useState("15:00");
  const [ends, setEnds] = useState("17:00");
  const [kind, setKind] = useState<DiscountKind>("percent");
  const [value, setValue] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const { pending, error, fieldErrors, submit } = useSubmit();
  const onSale = orderTypes.filter((type) => type.active);
  const discountValue = kind === "percent" ? parseWholeNumberInput(value) : parseUsdInput(value);
  const discount = discountValue === null || discountValue < 1 ? null : { kind, value: discountValue };
  const longDay = dateFormat(lang, { weekday: "long", timeZone: "UTC" });

  return (
    <form
      aria-labelledby="new-campaign-title"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        const startsMinute = minuteOf(starts, false);
        const endsMinute = minuteOf(ends, true);
        const invalid = {
          ...(weekdays.length === 0 ? { weekdays: t("Pick at least one day.") } : {}),
          ...(startsMinute === null ? { startsMinute: t("Enter a start time, such as 15:00.") } : {}),
          ...(endsMinute === null || (startsMinute !== null && endsMinute <= startsMinute) ? { endsMinute: t("End after the start, on the same day.") } : {}),
          ...(discount === null || (kind === "percent" && discount.value > 100)
            ? { discount: kind === "percent" ? t("Enter a whole percentage from 1 to 100.") : t("Enter an amount in dollars, such as 0.50.") }
            : {}),
          ...(chosen.length === 0
            ? { orderTypeIds: t("Pick at least one order type.") }
            : discount !== null && onSale.some((type) => chosen.includes(type.id) && !keepsMargin(type.priceCents, type.costCents, discount, minMarginPercent))
              ? { orderTypeIds: t("Some order types you picked would sell below their floor. Lower the discount, or leave them out.") }
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
      <h3 id="new-campaign-title">{t("New campaign")}</h3>
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
        <Field label={t("Name (Arabic)")} name="nameAr" type="text" lang="ar" value={nameAr} onChange={setNameAr} maxLength={60} error={fieldErrors.nameAr} />
      </div>
      <fieldset aria-describedby={problems.weekdays === undefined ? undefined : "campaign-days-error"}>
        <legend>{t("Days")}</legend>
        <div className="choices">
          {WEEK.map((day, index) => (
            <label key={day.getTime()}>
              <input
                type="checkbox"
                checked={weekdays.includes(index + 1)}
                onChange={(event) => {
                  setWeekdays(event.target.checked ? [...weekdays, index + 1] : weekdays.filter((entry) => entry !== index + 1));
                }}
              />{" "}
              {longDay.format(day)}
            </label>
          ))}
        </div>
        {problems.weekdays === undefined ? null : (
          <p id="campaign-days-error" className="field-error">
            {problems.weekdays}
          </p>
        )}
      </fieldset>
      <div className="form-grid">
        <TimeField label={t("Starts at")} value={starts} onChange={setStarts} error={problems.startsMinute ?? fieldErrors.startsMinute} />
        <TimeField
          label={t("Ends at")}
          value={ends}
          onChange={setEnds}
          hint={t("Café time. Use 00:00 to run until midnight.")}
          error={problems.endsMinute ?? fieldErrors.endsMinute}
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
          error={problems.discount ?? fieldErrors["discount.value"]}
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
          {onSale.map((type) => {
            const floor = marginFloorCents(type.costCents, minMarginPercent);
            const kept = discount === null || keepsMargin(type.priceCents, type.costCents, discount, minMarginPercent);
            const after = discount === null ? null : type.priceCents - unitDiscountCents(type.priceCents, discount);
            const prices = { name: nameOf(lang, type), price: formatUsd(type.priceCents, "en"), floor: formatUsd(floor, "en") };
            return (
              <li key={type.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    aria-invalid={kept || !chosen.includes(type.id) ? undefined : true}
                    aria-describedby={kept || !chosen.includes(type.id) ? undefined : `campaign-type-${type.id}-error`}
                    checked={chosen.includes(type.id)}
                    onChange={(event) => {
                      setChosen(event.target.checked ? [...chosen, type.id] : chosen.filter((id) => id !== type.id));
                    }}
                  />{" "}
                  {after === null
                    ? t("{name}: {price} (floor {floor})", prices)
                    : t("{name}: {price}, {after} with the discount (floor {floor})", { ...prices, after: formatUsd(after, "en") })}
                </label>
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
          <p id="campaign-types-error" className="field-error">
            {problems.orderTypeIds ?? say(fieldErrors.orderTypeIds ?? "")}
          </p>
        )}
      </fieldset>
      <button type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Start campaign")}
      </button>
    </form>
  );
}

/** `/campaigns`: quiet-hour campaigns (AC 35), counted in the café's time zone and checked against the margin floor. */
export function CampaignsPage() {
  const t = useT(AR);
  const lang = useLang();
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setCampaigns] = useApiData("/api/campaigns", campaignsSchema, reloadKey);
  const [setup] = useApiData("/api/cafe", cafeSetupSchema);
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  const ending = useSubmit();
  if (state.status !== "loaded" || setup.status !== "loaded") {
    return <PageStatus state={state.status === "failed" ? state : setup} />;
  }
  const { orderTypes, cafe } = setup.data;
  const change: Change = async (method, path, body) => {
    setNotice(null);
    setCampaigns(await apiRequest(method, path, campaignsSchema, body));
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
      {notice === null ? null : <Notice>{notice(t, lang)}</Notice>}
      <FormError message={ending.error} />
      <h3>{t("Running")}</h3>
      {state.data.running.length === 0 ? (
        <p className="empty">{t("No campaigns running. Start one below for the hours the busy and quiet hours show as quiet.")}</p>
      ) : (
        <ul className="items">
          {state.data.running.map((campaign) => (
            <li key={campaign.id} className="row">
              <span className="row-main">
                <strong>{nameOf(lang, campaign)}</strong>: {describe(t, lang, campaign, orderTypes)} <span className="badge badge-success">{t("running")}</span>
              </span>
              <ConfirmButton
                label={t("End {name}", { name: nameOf(lang, campaign) })}
                confirmLabel={t("Yes, end {name}", { name: nameOf(lang, campaign) })}
                pending={ending.pending}
                onConfirm={() => {
                  void ending.submit(() => change("POST", `/api/campaigns/${campaign.id}/end`)).then((result) => {
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
      <NewCampaignForm orderTypes={orderTypes} minMarginPercent={cafe.minMarginPercent} change={change} />
      {state.data.ended.length === 0 ? null : (
        <>
          <h3>{t("Ended")}</h3>
          <ul className="items">
            {state.data.ended.map((campaign) => (
              <li key={campaign.id} className="row">
                <span className="row-main">
                  <strong>{nameOf(lang, campaign)}</strong>: {describe(t, lang, campaign, orderTypes)} <span className="badge">{t("ended")}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
