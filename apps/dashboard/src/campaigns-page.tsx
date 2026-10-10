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
  type OrderType,
} from "@cafe-loyalty/shared";
import { useId, useState } from "react";
import { apiRequest, isStale } from "./api.js";
import { ConfirmButton, Field, FormError, Notice, useSubmit } from "./forms.js";
import { parseUsdInput, parseWholeNumberInput } from "./money-input.js";
import { PageStatus, useApiData } from "./session.js";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

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

const discountText = (discount: Campaign["discount"]): string =>
  discount.kind === "percent" ? `${String(discount.value)}% off` : `${formatUsd(discount.value, "en")} off`;

/** "Mon, Tue, Wed, 15:00 to 17:00: 20% off Latte, Cake". */
function describe(campaign: Campaign, orderTypes: readonly OrderType[]): string {
  const days = campaign.weekdays.map((day) => WEEKDAYS[day - 1]?.slice(0, 3) ?? "?").join(", ");
  const names = campaign.orderTypeIds.map((id) => orderTypes.find((type) => type.id === id)?.nameEn ?? "a removed order type").join(", ");
  return `${days}, ${timeOf(campaign.startsMinute)} to ${timeOf(campaign.endsMinute)}: ${discountText(campaign.discount)} ${names}`;
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

  return (
    <form
      aria-labelledby="new-campaign-title"
      onSubmit={(event) => {
        event.preventDefault();
        const startsMinute = minuteOf(starts, false);
        const endsMinute = minuteOf(ends, true);
        const invalid = {
          ...(weekdays.length === 0 ? { weekdays: "Pick at least one day." } : {}),
          ...(startsMinute === null ? { startsMinute: "Enter a start time, such as 15:00." } : {}),
          ...(endsMinute === null || (startsMinute !== null && endsMinute <= startsMinute) ? { endsMinute: "End after the start, on the same day." } : {}),
          ...(discount === null || (kind === "percent" && discount.value > 100)
            ? { discount: kind === "percent" ? "Enter a whole percentage from 1 to 100." : "Enter an amount in dollars, such as 0.50." }
            : {}),
          ...(chosen.length === 0 ? { orderTypeIds: "Pick at least one order type." } : {}),
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
      <h3 id="new-campaign-title">New campaign</h3>
      <FormError message={error} />
      <Field label="Name (English)" name="nameEn" type="text" value={nameEn} onChange={setNameEn} maxLength={60} hint="Such as Quiet afternoons." error={fieldErrors.nameEn} />
      <Field label="Name (Arabic)" name="nameAr" type="text" lang="ar" value={nameAr} onChange={setNameAr} maxLength={60} error={fieldErrors.nameAr} />
      <fieldset aria-describedby={problems.weekdays === undefined ? undefined : "campaign-days-error"}>
        <legend>Days</legend>
        <div className="choices">
          {WEEKDAYS.map((day, index) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={weekdays.includes(index + 1)}
                onChange={(event) => {
                  setWeekdays(event.target.checked ? [...weekdays, index + 1] : weekdays.filter((entry) => entry !== index + 1));
                }}
              />{" "}
              {day}
            </label>
          ))}
        </div>
        {problems.weekdays === undefined ? null : (
          <p id="campaign-days-error" className="field-error">
            {problems.weekdays}
          </p>
        )}
      </fieldset>
      <TimeField label="Starts at" value={starts} onChange={setStarts} error={problems.startsMinute ?? fieldErrors.startsMinute} />
      <TimeField label="Ends at" value={ends} onChange={setEnds} hint="Café time. Use 00:00 to run until midnight." error={problems.endsMinute ?? fieldErrors.endsMinute} />
      <fieldset>
        <legend>Discount</legend>
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
              {option === "percent" ? "Percent off" : "Amount off each item"}
            </label>
          ))}
        </div>
        <Field
          label={kind === "percent" ? "Percent off" : "Amount off (USD)"}
          name="discount"
          type="text"
          inputMode={kind === "percent" ? "numeric" : "decimal"}
          value={value}
          onChange={setValue}
          hint={kind === "percent" ? "A whole number, such as 20. The discount rounds down to the cent, in your favour." : "Such as 0.50."}
          error={problems.discount ?? fieldErrors["discount.value"]}
        />
      </fieldset>
      <fieldset aria-describedby={(problems.orderTypeIds ?? fieldErrors.orderTypeIds) === undefined ? "campaign-types-hint" : "campaign-types-hint campaign-types-error"}>
        <legend>Order types</legend>
        <p id="campaign-types-hint" className="hint">
          Your minimum margin is {minMarginPercent}% over cost (Café page): a campaign that takes a picked order type below its floor is refused.
        </p>
        {onSale.length === 0 ? <p>No order types on sale. Add some on the Café page first.</p> : null}
        <ul className="choices-list">
          {onSale.map((type) => {
            const floor = marginFloorCents(type.costCents, minMarginPercent);
            const kept = discount === null || keepsMargin(type.priceCents, type.costCents, discount, minMarginPercent);
            const after = discount === null ? null : type.priceCents - unitDiscountCents(type.priceCents, discount);
            return (
              <li key={type.id}>
                <label>
                  <input
                    type="checkbox"
                    aria-invalid={kept || !chosen.includes(type.id) ? undefined : true}
                    aria-describedby={kept || !chosen.includes(type.id) ? undefined : `campaign-type-${type.id}-error`}
                    checked={chosen.includes(type.id)}
                    onChange={(event) => {
                      setChosen(event.target.checked ? [...chosen, type.id] : chosen.filter((id) => id !== type.id));
                    }}
                  />{" "}
                  {type.nameEn}: {formatUsd(type.priceCents, "en")}
                  {after === null ? "" : `, ${formatUsd(after, "en")} with the discount`} (floor {formatUsd(floor, "en")})
                </label>
                {kept || !chosen.includes(type.id) ? null : (
                  <p id={`campaign-type-${type.id}-error`} className="field-error">
                    Below its floor: lower the discount or leave it out.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {(problems.orderTypeIds ?? fieldErrors.orderTypeIds) === undefined ? null : (
          <p id="campaign-types-error" className="field-error">
            {problems.orderTypeIds ?? fieldErrors.orderTypeIds}
          </p>
        )}
      </fieldset>
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Start campaign"}
      </button>
    </form>
  );
}

/** `/campaigns`: quiet-hour campaigns (AC 35), counted in the café's time zone and checked against the margin floor. */
export function CampaignsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setCampaigns] = useApiData("/api/campaigns", campaignsSchema, reloadKey);
  const [setup] = useApiData("/api/cafe", cafeSetupSchema);
  const [notice, setNotice] = useState<string | null>(null);
  const ending = useSubmit();
  if (state.status !== "loaded" || setup.status !== "loaded") {
    return <PageStatus state={state.status === "failed" ? state : setup} />;
  }
  const { orderTypes, cafe } = setup.data;
  const change: Change = async (method, path, body) => {
    setNotice(null);
    setCampaigns(await apiRequest(method, path, campaignsSchema, body));
    setNotice("Saved. Counter phones pick up the change within 5 minutes.");
  };

  return (
    <section aria-labelledby="campaigns-page-title">
      <h2 id="campaigns-page-title" tabIndex={-1} data-focus-after-change>
        Campaigns
      </h2>
      <p>A campaign takes money off chosen order types at quiet hours. The counter gives the discount to every loyalty card holder.</p>
      {notice === null ? null : <Notice>{notice}</Notice>}
      <FormError message={ending.error} />
      <h3>Running</h3>
      {state.data.running.length === 0 ? (
        <p>No campaigns running.</p>
      ) : (
        <ul className="items">
          {state.data.running.map((campaign) => (
            <li key={campaign.id}>
              <strong>{campaign.nameEn}</strong>: {describe(campaign, orderTypes)}{" "}
              <ConfirmButton
                label={`End ${campaign.nameEn}`}
                confirmLabel={`Yes, end ${campaign.nameEn}`}
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
          <h3>Ended</h3>
          <ul className="items">
            {state.data.ended.map((campaign) => (
              <li key={campaign.id}>
                <strong>{campaign.nameEn}</strong>: {describe(campaign, orderTypes)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
