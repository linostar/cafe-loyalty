import {
  CAFE_PLANS,
  PAYMENT_METHODS,
  adminCafeSchema,
  adminCafesSchema,
  formatUsd,
  operatorSessionSchema,
  type AdminCafe,
  type CafePlan,
  type OperatorSession,
  type PaymentMethod,
} from "@cafe-loyalty/shared";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiRequestError, apiRequest, noContent } from "./api.js";
import { Field, FormError, Notice, useSubmit } from "./forms.js";
import { parseUsdInput } from "./money-input.js";
import { PageStatus, SessionEndedContext, useApiData } from "./session.js";

const PLAN_LABELS: Record<CafePlan, string> = { pilot: "Pilot", active: "Active", suspended: "Suspended" };
const PLAN_HINTS: Record<CafePlan, string> = {
  pilot: "Trying the service.",
  active: "Paying customer.",
  suspended: "Its signup page enrols no one; its counter still records and syncs visits.",
};
const METHOD_LABELS: Record<PaymentMethod, string> = { cash: "Cash", whish: "Whish", omt: "OMT", bank_transfer: "Bank transfer", other: "Other" };
const dayFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const today = (): string => new Date().toISOString().slice(0, 10);

function AdminLoginForm({ notice, onSignedIn }: { notice: string | null; onSignedIn: (session: OperatorSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <section aria-labelledby="admin-login-title">
      <h2 id="admin-login-title">Operator sign-in</h2>
      <p className="page-intro">For the service&apos;s operator. Café owners sign in on the dashboard&apos;s home page.</p>
      {notice === null ? null : <Notice>{notice}</Notice>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(() => apiRequest("POST", "/api/admin/login", operatorSessionSchema, { email, password })).then((result) => {
            if (result.ok) {
              onSignedIn(result.value);
            }
          });
        }}
      >
        <FormError message={error} />
        <Field label="Email" name="email" type="email" autoComplete="username" value={email} onChange={setEmail} error={fieldErrors.email} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={setPassword} error={fieldErrors.password} />
        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </section>
  );
}

function PlanForm({ cafe, onSaved }: { cafe: AdminCafe; onSaved: (cafe: AdminCafe, notice: string) => void }) {
  const [plan, setPlan] = useState<CafePlan>(cafe.plan);
  const { pending, error, submit } = useSubmit();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => apiRequest("PATCH", `/api/admin/cafes/${cafe.id}`, adminCafeSchema, { plan })).then((result) => {
          if (result.ok) {
            onSaved(result.value, `${cafe.name} is now on the ${PLAN_LABELS[result.value.plan].toLowerCase()} plan.`);
          }
        });
      }}
    >
      <FormError message={error} />
      <fieldset>
        <legend>Plan of {cafe.name}</legend>
        <div className="choices">
          {CAFE_PLANS.map((option) => (
            <label key={option}>
              <input
                type="radio"
                name={`plan-${cafe.id}`}
                checked={plan === option}
                onChange={() => {
                  setPlan(option);
                }}
              />{" "}
              {PLAN_LABELS[option]}
            </label>
          ))}
        </div>
        <p className="hint">{PLAN_HINTS[plan]}</p>
      </fieldset>
      <button type="submit" disabled={pending || plan === cafe.plan}>
        {pending ? "Saving…" : "Save plan"}
      </button>
    </form>
  );
}

function PaymentForm({ cafe, onSaved }: { cafe: AdminCafe; onSaved: (cafe: AdminCafe, notice: string) => void }) {
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const amountCents = parseUsdInput(amount);
        if (amountCents === null || amountCents < 1) {
          setProblems({ amountCents: "Enter an amount in dollars over 0, such as 25 or 25.00." });
          return;
        }
        setProblems({});
        void submit(() => apiRequest("POST", `/api/admin/cafes/${cafe.id}/payments`, adminCafeSchema, { amountCents, paidOn, method, reference })).then((result) => {
          if (result.ok) {
            setAmount("");
            setReference("");
            onSaved(result.value, `Recorded ${formatUsd(amountCents, "en")} from ${cafe.name}, paid by ${METHOD_LABELS[method]} on ${dayFormat.format(new Date(paidOn))}.`);
          }
        });
      }}
    >
      <h4>Record a payment</h4>
      <FormError message={error} />
      <Field
        label="Amount (USD)"
        name="amount"
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={setAmount}
        error={problems.amountCents ?? fieldErrors.amountCents}
      />
      <Field label="Paid on" name="paidOn" type="date" value={paidOn} onChange={setPaidOn} error={fieldErrors.paidOn} />
      <fieldset>
        <legend>Paid by</legend>
        <div className="choices">
          {PAYMENT_METHODS.map((option) => (
            <label key={option}>
              <input
                type="radio"
                name={`method-${cafe.id}`}
                checked={method === option}
                onChange={() => {
                  setMethod(option);
                }}
              />{" "}
              {METHOD_LABELS[option]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field
        label="Reference"
        name="reference"
        type="text"
        value={reference}
        onChange={setReference}
        maxLength={100}
        optional
        hint="Optional: a receipt or transfer number. No names or phone numbers."
        error={fieldErrors.reference}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Recording…" : "Record payment"}
      </button>
    </form>
  );
}

function CafeCard({ cafe, onSaved }: { cafe: AdminCafe; onSaved: (cafe: AdminCafe, notice: string) => void }) {
  const titleId = `admin-cafe-${cafe.id}`;
  return (
    <li>
      <section aria-labelledby={titleId} className="card">
        <h3 id={titleId}>
          {cafe.name} <span className={cafe.plan === "suspended" ? "badge badge-warning" : cafe.plan === "active" ? "badge badge-success" : "badge"}>{PLAN_LABELS[cafe.plan]}</span>
        </h3>
        <p className="hint">
          Created {dayFormat.format(new Date(cafe.createdAt))}. Paid in all: {formatUsd(cafe.paidCents, "en")}.
        </p>
        <PlanForm cafe={cafe} onSaved={onSaved} />
        <PaymentForm cafe={cafe} onSaved={onSaved} />
        {cafe.payments.length === 0 ? (
          <p className="empty">No payments recorded yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>Latest payments of {cafe.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Paid on</th>
                  <th scope="col">Amount</th>
                  <th scope="col">By</th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {cafe.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{dayFormat.format(new Date(payment.paidOn))}</td>
                    <td>{formatUsd(payment.amountCents, "en")}</td>
                    <td>{METHOD_LABELS[payment.method]}</td>
                    <td>{payment.reference ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </li>
  );
}

function CafesPage() {
  const [state, setData] = useApiData("/api/admin/cafes", adminCafesSchema);
  const [notice, setNotice] = useState<string | null>(null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const { cafes } = state.data;
  return (
    <section aria-labelledby="admin-cafes-title">
      <h2 id="admin-cafes-title" tabIndex={-1}>
        Cafés
      </h2>
      <p className="page-intro">Set each café&apos;s plan and record the payments it made. Every change goes in the café&apos;s audit log.</p>
      {notice === null ? null : <Notice>{notice}</Notice>}
      {cafes.length === 0 ? (
        <p className="empty">No cafés yet. Create one with create-invite.</p>
      ) : (
        <ul className="admin-cafes">
          {cafes.map((cafe) => (
            <CafeCard
              key={cafe.id}
              cafe={cafe}
              onSaved={(saved, message) => {
                setData({ cafes: cafes.map((entry) => (entry.id === saved.id ? saved : entry)) });
                setNotice(message);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type AdminState =
  | { status: "loading" }
  | { status: "signed-out"; notice: string | null }
  | { status: "signed-in"; session: OperatorSession }
  | { status: "unavailable"; message: string };

/** `/admin`: the operator's screen (AC 39), behind its own sign-in. `layout` wraps every state in the page's frame. */
export function AdminArea({ layout }: { layout: (children: ReactNode, session: OperatorSession | null) => ReactNode }) {
  const [state, setState] = useState<AdminState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const signOut = useCallback((notice: string) => {
    setState({ status: "signed-out", notice });
  }, []);
  const { pending, error, submit } = useSubmit();

  useEffect(() => {
    let current = true;
    apiRequest("GET", "/api/admin/session", operatorSessionSchema).then(
      (session) => {
        if (current) {
          setState({ status: "signed-in", session });
        }
      },
      (failure: unknown) => {
        if (!current) {
          return;
        }
        if (failure instanceof ApiRequestError && (failure.failure.code === "UNAUTHENTICATED" || failure.failure.code === "FORBIDDEN")) {
          setState({ status: "signed-out", notice: null });
        } else {
          setState({ status: "unavailable", message: failure instanceof Error ? failure.message : "Could not check your session." });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  switch (state.status) {
    case "loading":
      return layout(<p role="status">Loading…</p>, null);
    case "unavailable":
      return layout(
        <>
          <p role="alert" className="form-error">
            {state.message}
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </>,
        null,
      );
    case "signed-out":
      return layout(
        <AdminLoginForm
          notice={state.notice}
          onSignedIn={(session) => {
            setState({ status: "signed-in", session });
          }}
        />,
        null,
      );
    case "signed-in":
      return (
        <SessionEndedContext.Provider value={signOut}>
          {layout(
            <>
              <CafesPage />
              <section aria-labelledby="admin-sign-out-title" className="card">
                <h3 id="admin-sign-out-title">Sign out</h3>
                <p>Signing out ends your operator session on every device.</p>
                <FormError message={error} />
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    void submit(() => apiRequest("POST", "/api/admin/logout", noContent)).then((result) => {
                      if (result.ok) {
                        signOut("You signed out on every device.");
                      }
                    });
                  }}
                >
                  {pending ? "Signing out…" : "Sign out"}
                </button>
              </section>
            </>,
            state.session,
          )}
        </SessionEndedContext.Provider>
      );
  }
}
