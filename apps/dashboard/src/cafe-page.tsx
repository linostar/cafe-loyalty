import { cafeSetupSchema, formatUsd, type CafeSetup, type OrderType } from "@cafe-loyalty/shared";
import { useState } from "react";
import { apiRequest } from "./api.js";
import { Field, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
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
      <ProgramForm program={setup.program} save={save} />
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
