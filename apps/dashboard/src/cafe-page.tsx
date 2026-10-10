import {
  WIN_BACK_MAX_COOLDOWN_DAYS,
  WIN_BACK_OFFER_DAYS,
  cafeSetupSchema,
  formatUsd,
  joinLinkSchema,
  type CafeSetup,
  type OrderType,
  type WinBackSettings,
} from "@cafe-loyalty/shared";
import { useState } from "react";
import { renderSVG } from "uqr";
import { apiRequest } from "./api.js";
import { ConfirmButton, Field, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
import { centsToInput, parseUsdInput, parseWholeNumberInput } from "./money-input.js";
import { PageStatus, useApiData } from "./session.js";

type Save = (method: "PATCH" | "PUT" | "POST", path: string, body: unknown) => Promise<boolean>;

function CafeNameForm({ name, save }: { name: string; save: Save }) {
  const [value, setValue] = useState(name);
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="cafe-name-title"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => save("PATCH", "/api/cafe", { name: value }));
      }}
    >
      <h3 id="cafe-name-title">Café name</h3>
      <FormError message={error} />
      <Field label="Name" name="name" type="text" value={value} onChange={setValue} maxLength={120} error={fieldErrors.name} />
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save name"}
      </button>
    </form>
  );
}

function ProgramForm({ program, save }: { program: CafeSetup["program"]; save: Save }) {
  const [stamps, setStamps] = useState(program === null ? "" : String(program.stampsRequired));
  const [rewardEn, setRewardEn] = useState(program?.rewardNameEn ?? "");
  const [rewardAr, setRewardAr] = useState(program?.rewardNameAr ?? "");
  const [stampsError, setStampsError] = useState<string | undefined>(undefined);
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="program-title"
      onSubmit={(event) => {
        event.preventDefault();
        const stampsRequired = parseWholeNumberInput(stamps);
        setStampsError(stampsRequired === null ? "Enter a whole number, such as 9." : undefined);
        if (stampsRequired === null) {
          return;
        }
        void submit(() => save("PUT", "/api/cafe/program", { stampsRequired, rewardNameEn: rewardEn, rewardNameAr: rewardAr }));
      }}
    >
      <h3 id="program-title">Loyalty program</h3>
      {program === null ? <p>Set the program before baristas start giving stamps.</p> : null}
      <FormError message={error} />
      <Field
        label="Stamps for a reward"
        name="stampsRequired"
        type="text"
        inputMode="numeric"
        value={stamps}
        onChange={setStamps}
        hint="1 to 50."
        error={stampsError ?? fieldErrors.stampsRequired}
      />
      <Field label="Reward (English)" name="rewardNameEn" type="text" value={rewardEn} onChange={setRewardEn} maxLength={80} error={fieldErrors.rewardNameEn} />
      <Field label="Reward (Arabic)" name="rewardNameAr" type="text" lang="ar" value={rewardAr} onChange={setRewardAr} maxLength={80} error={fieldErrors.rewardNameAr} />
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save program"}
      </button>
    </form>
  );
}

/** The café's minimum margin over cost, below which no campaign may discount (AC 35). */
function MarginForm({ minMarginPercent, save }: { minMarginPercent: number; save: Save }) {
  const [value, setValue] = useState(String(minMarginPercent));
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="margin-title"
      onSubmit={(event) => {
        event.preventDefault();
        const percent = parseWholeNumberInput(value);
        setInvalid(percent === null || percent > 1000 ? "Enter a whole percentage from 0 to 1000, such as 30." : undefined);
        if (percent !== null && percent <= 1000) {
          void submit(() => save("PATCH", "/api/cafe", { minMarginPercent: percent }));
        }
      }}
    >
      <h3 id="margin-title">Minimum margin</h3>
      <FormError message={error} />
      <Field
        label="Minimum margin over cost (%)"
        name="minMarginPercent"
        type="text"
        inputMode="numeric"
        value={value}
        onChange={setValue}
        hint="Campaigns never sell an item for less than its cost plus this much: 30% keeps a drink that costs $1.00 at $1.30 or more. Running campaigns keep the margin they started with."
        error={invalid ?? fieldErrors.minMarginPercent}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save margin"}
      </button>
    </form>
  );
}

/**
 * The café's win-back offer (AC 36): what a regular who stopped coming gets off their next visit, if anything, and how
 * long before the same card can get it again.
 */
function WinBackForm({ winBack, save }: { winBack: WinBackSettings; save: Save }) {
  const [kind, setKind] = useState<"none" | "percent" | "amount">(winBack.discount?.kind ?? "none");
  const [value, setValue] = useState(winBack.discount === null ? "" : winBack.discount.kind === "percent" ? String(winBack.discount.value) : centsToInput(winBack.discount.value));
  const [cooldown, setCooldown] = useState(String(winBack.cooldownDays));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="win-back-title"
      onSubmit={(event) => {
        event.preventDefault();
        const amount = kind === "percent" ? parseWholeNumberInput(value) : kind === "amount" ? parseUsdInput(value) : null;
        const days = parseWholeNumberInput(cooldown);
        const invalid: Record<string, string> = {
          ...(kind !== "none" && (amount === null || amount < 1 || (kind === "percent" && amount > 100))
            ? { discount: kind === "percent" ? "Enter a whole percentage from 1 to 100." : "Enter an amount in dollars, such as 0.50." }
            : {}),
          ...(days === null || days < WIN_BACK_OFFER_DAYS || days > WIN_BACK_MAX_COOLDOWN_DAYS
            ? { cooldownDays: `Enter a whole number of days from ${String(WIN_BACK_OFFER_DAYS)} to ${String(WIN_BACK_MAX_COOLDOWN_DAYS)}.` }
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
      <h3 id="win-back-title">Win-back offer</h3>
      <p>
        When a regular (3 visits or more) stays away much longer than usual, at least 2 weeks, their card offers this off their next visit, for{" "}
        {WIN_BACK_OFFER_DAYS} days, if they agreed to receive offers. It never takes an item below its minimum margin.
      </p>
      <FormError message={error} />
      <fieldset>
        <legend>Discount</legend>
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
              {label}
            </label>
          ))}
        </div>
        {kind === "none" ? null : (
          <Field
            label={kind === "percent" ? "Percent off" : "Amount off (USD)"}
            name="winBackDiscount"
            type="text"
            inputMode={kind === "percent" ? "numeric" : "decimal"}
            value={value}
            onChange={setValue}
            hint={kind === "percent" ? "A whole number, such as 15." : "Such as 0.50."}
            error={problems.discount ?? fieldErrors["discount.value"]}
          />
        )}
      </fieldset>
      <Field
        label="Days before the same card can get it again"
        name="cooldownDays"
        type="text"
        inputMode="numeric"
        value={cooldown}
        onChange={setCooldown}
        hint={`At least ${String(WIN_BACK_OFFER_DAYS)}, how long an offer lasts. Offers already given keep their terms.`}
        error={problems.cooldownDays ?? fieldErrors.cooldownDays}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save win-back offer"}
      </button>
    </form>
  );
}

/** Adds an order type, or edits one when `orderType` is given. */
function OrderTypeForm({ orderType, save, onDone }: { orderType?: OrderType; save: Save; onDone?: () => void }) {
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
      onSubmit={(event) => {
        event.preventDefault();
        const priceCents = parseUsdInput(price);
        const costCents = parseUsdInput(cost);
        const stampsEarned = parseWholeNumberInput(stamps);
        const invalid = {
          ...(priceCents === null ? { priceCents: "Enter a price in dollars up to 1,000,000, such as 2.50." } : {}),
          ...(costCents === null ? { costCents: "Enter a cost in dollars up to 1,000,000, such as 0.70." } : {}),
          ...(stampsEarned === null ? { stampsEarned: "Enter a whole number, such as 1." } : {}),
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
      <h4 id={titleId}>{orderType === undefined ? "Add an order type" : `Edit ${orderType.nameEn}`}</h4>
      <FormError message={error} />
      <Field label="Name (English)" name="nameEn" type="text" value={nameEn} onChange={setNameEn} maxLength={60} error={fieldErrors.nameEn} />
      <Field label="Name (Arabic)" name="nameAr" type="text" lang="ar" value={nameAr} onChange={setNameAr} maxLength={60} error={fieldErrors.nameAr} />
      <Field
        label="Price (USD)"
        name="price"
        type="text"
        inputMode="decimal"
        value={price}
        onChange={setPrice}
        error={amountErrors.priceCents ?? fieldErrors.priceCents}
      />
      <Field
        label="Cost to make (USD)"
        name="cost"
        type="text"
        inputMode="decimal"
        value={cost}
        onChange={setCost}
        hint="What one costs you in ingredients and cup. Offers never go below cost."
        error={amountErrors.costCents ?? fieldErrors.costCents}
      />
      <Field
        label="Stamps earned"
        name="stampsEarned"
        type="text"
        inputMode="numeric"
        value={stamps}
        onChange={setStamps}
        hint="0 to 10."
        error={amountErrors.stampsEarned ?? fieldErrors.stampsEarned}
      />
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => {
              setActive(event.target.checked);
            }}
          />{" "}
          On sale (shown at the counter)
        </label>
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : orderType === undefined ? "Add order type" : "Save changes"}
      </button>
      {onDone === undefined || orderType === undefined ? null : (
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      )}
    </form>
  );
}

function OrderTypeItem({ orderType, save }: { orderType: OrderType; save: Save }) {
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
    <li ref={item}>
      <strong>{orderType.nameEn}</strong> <span lang="ar">{orderType.nameAr}</span>
      <br />
      {formatUsd(orderType.priceCents, "en")} · cost {formatUsd(orderType.costCents, "en")} · {orderType.stampsEarned} stamp
      {orderType.stampsEarned === 1 ? "" : "s"}
      {orderType.active ? "" : " · not on sale"}{" "}
      <button
        type="button"
        aria-label={`Edit ${orderType.nameEn}`}
        onClick={() => {
          setEditing(true);
        }}
      >
        Edit
      </button>
    </li>
  );
}

/** The QR customers scan at the counter to get a card (AC 4), for printing; replacing it retires the old one. */
function SignupQr() {
  const [state, setLink] = useApiData("/api/cafe/join", joinLinkSchema);
  const { pending, error, submit } = useSubmit();
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(state.data.joinUrl, { border: 4 }))}`;
  return (
    <section aria-labelledby="signup-qr-title">
      <h3 id="signup-qr-title" tabIndex={-1} data-focus-after-change>
        Customer signup QR
      </h3>
      <p>Print this and put it at the counter. Customers scan it to get their loyalty card.</p>
      <img className="signup-qr" src={qr} alt="QR code customers scan to get a loyalty card" width={200} height={200} />
      <p className="link">{state.data.joinUrl}</p>
      <FormError message={error} />
      <p>Replace the code only if the printed one was misused: the old one stops working at once.</p>
      <ConfirmButton
        label="Replace code"
        confirmLabel="Yes, replace the code"
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
  const [state, setSetup] = useApiData("/api/cafe", cafeSetupSchema);
  const [saved, setSaved] = useState<string | null>(null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const setup = state.data;

  const save: Save = async (method, path, body) => {
    setSaved(null);
    setSetup(await apiRequest(method, path, cafeSetupSchema, body));
    setSaved("Saved.");
    return true;
  };

  return (
    <section aria-labelledby="cafe-page-title">
      <h2 id="cafe-page-title">Café</h2>
      {saved === null ? null : <Notice>{saved}</Notice>}
      <CafeNameForm name={setup.cafe.name} save={save} />
      <SignupQr />
      <ProgramForm program={setup.program} save={save} />
      <MarginForm minMarginPercent={setup.cafe.minMarginPercent} save={save} />
      <WinBackForm winBack={setup.cafe.winBack} save={save} />
      <section aria-labelledby="order-types-title">
        <h3 id="order-types-title">Order types</h3>
        {setup.orderTypes.length === 0 ? (
          <p>No order types yet. Add what baristas stamp, such as an espresso drink.</p>
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
