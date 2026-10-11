import {
  CAFE_PLANS,
  PAYMENT_METHODS,
  adminCafeSchema,
  adminCafesSchema,
  apiText,
  formatUsd,
  operatorSessionSchema,
  type AdminCafe,
  type CafePlan,
  type OperatorSession,
  type PaymentMethod,
} from "@cafe-loyalty/shared";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiRequestError, apiRequest, isStale, noContent } from "./api.js";
import { Field, FormError, Notice, useSubmit } from "./forms.js";
import { dateFormat, useApiText, useLang, useT } from "./i18n.js";
import { parseUsdInput } from "./money-input.js";
import { PageStatus, SessionEndedContext, useApiData } from "./session.js";

const AR = {
  Pilot: "تجريبية",
  Active: "فعّالة",
  Suspended: "موقوفة",
  "Trying the service.": "تجرّب الخدمة.",
  "Paying customer.": "عميل يدفع.",
  "Its signup page enrols no one; its counter still records and syncs visits.": "صفحة التسجيل لا تقبل أحداً؛ ولا يزال الكاونتر يسجّل الزيارات ويزامنها.",
  Cash: "نقداً",
  Whish: "Whish",
  OMT: "OMT",
  "Bank transfer": "تحويل مصرفي",
  Other: "أخرى",
  "for {name}": "لـ{name}",
  "of {name}": "لـ{name}",
  "Operator sign-in": "تسجيل دخول المشغّل",
  "For the service's operator. Café owners sign in on the dashboard's home page.": "لمشغّل الخدمة. يسجّل مالكو المقاهي الدخول من الصفحة الرئيسية للوحة التحكم.",
  Email: "البريد الإلكتروني",
  Password: "كلمة المرور",
  "Signing in…": "جارٍ تسجيل الدخول…",
  "Sign in": "تسجيل الدخول",
  "{name} is now on the {plan} plan.": "أصبح {name} على الخطة {plan}.",
  "Plan of {name}": "خطة {name}",
  "Save plan": "حفظ الخطة",
  "Enter an amount in dollars over 0, such as 25 or 25.00.": "أدخل مبلغاً بالدولار أكبر من 0، مثل 25 أو 25.00.",
  "Recorded {amount} from {name}, paid by {method} on {day}.": "سُجّل مبلغ {amount} من {name}، بتاريخ {day}، طريقة الدفع: {method}.",
  "Record a payment": "تسجيل دفعة",
  "Amount (USD)": "المبلغ (بالدولار)",
  "Paid on": "تاريخ الدفع",
  "Paid by": "طريقة الدفع",
  Reference: "المرجع",
  "Optional: a receipt or transfer number. No names or phone numbers.": "اختياري: رقم إيصال أو تحويل. بلا أسماء أو أرقام هواتف.",
  "Recording…": "جارٍ التسجيل…",
  "Record payment": "تسجيل الدفعة",
  ", plan:": "، الخطة:",
  "Created {day}. Paid in all: {amount}.": "أُنشئ في {day}. المدفوع إجمالاً: {amount}.",
  "No payments recorded yet.": "لا دفعات مسجّلة بعد.",
  "Latest payments of {name}": "أحدث دفعات {name}",
  Amount: "المبلغ",
  By: "الطريقة",
  Cafés: "المقاهي",
  "Set each café's plan and record the payments it made. Every change goes in the café's audit log.": "حدّد خطة كل مقهى وسجّل الدفعات التي قام بها. يُسجَّل كل تغيير في سجل تدقيق المقهى.",
  "No cafés yet. Create one with create-invite.": "لا مقاهٍ بعد. أنشئ واحداً عبر create-invite.",
  "Sign out": "تسجيل الخروج",
  "Signing out ends your operator session on every device.": "تسجيل الخروج ينهي جلسة المشغّل على كل الأجهزة.",
  "Signing out…": "جارٍ تسجيل الخروج…",
  "You signed out on every device.": "سجّلت خروجك من كل الأجهزة.",
} as const;

const PLAN_LABELS = { pilot: "Pilot", active: "Active", suspended: "Suspended" } as const satisfies Record<CafePlan, keyof typeof AR>;
const PLAN_HINTS = {
  pilot: "Trying the service.",
  active: "Paying customer.",
  suspended: "Its signup page enrols no one; its counter still records and syncs visits.",
} as const satisfies Record<CafePlan, keyof typeof AR>;
const METHOD_LABELS = { cash: "Cash", whish: "Whish", omt: "OMT", bank_transfer: "Bank transfer", other: "Other" } as const satisfies Record<PaymentMethod, keyof typeof AR>;
const DAY = { dateStyle: "medium", timeZone: "UTC" } as const;
/** The operator's own calendar day, YYYY-MM-DD (not UTC's, which is still yesterday after midnight in Beirut). */
const today = (): string => {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
/** Said after a control's visible name, so a screen reader's list of controls tells each café's apart. */
const forCafe = (text: string) => <span className="visually-hidden"> {text}</span>;

function AdminLoginForm({ notice, onSignedIn }: { notice: string | null; onSignedIn: (session: OperatorSession) => void }) {
  const t = useT(AR);
  const api = useApiText();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <section aria-labelledby="admin-login-title">
      <h2 id="admin-login-title">{t("Operator sign-in")}</h2>
      <p className="page-intro">{t("For the service's operator. Café owners sign in on the dashboard's home page.")}</p>
      {notice === null ? null : <Notice>{api(notice)}</Notice>}
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
        <Field label={t("Email")} name="email" type="email" autoComplete="username" value={email} onChange={setEmail} error={fieldErrors.email} />
        <Field label={t("Password")} name="password" type="password" autoComplete="current-password" value={password} onChange={setPassword} error={fieldErrors.password} />
        <button type="submit" disabled={pending}>
          {pending ? t("Signing in…") : t("Sign in")}
        </button>
      </form>
    </section>
  );
}

function PlanForm({ cafe, onSaved }: { cafe: AdminCafe; onSaved: (cafe: AdminCafe, notice: string) => void }) {
  const t = useT(AR);
  const [plan, setPlan] = useState<CafePlan>(cafe.plan);
  const { pending, error, submit } = useSubmit();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => apiRequest("PATCH", `/api/admin/cafes/${cafe.id}`, adminCafeSchema, { plan })).then((result) => {
          if (result.ok) {
            onSaved(result.value, t("{name} is now on the {plan} plan.", { name: cafe.name, plan: t(PLAN_LABELS[result.value.plan]).toLowerCase() }));
          }
        });
      }}
    >
      <FormError message={error} />
      <fieldset>
        <legend>{t("Plan of {name}", { name: cafe.name })}</legend>
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
              {t(PLAN_LABELS[option])}
            </label>
          ))}
        </div>
        <p className="hint">{t(PLAN_HINTS[plan])}</p>
      </fieldset>
      <button type="submit" disabled={pending || plan === cafe.plan}>
        {pending ? t("Saving…") : t("Save plan")}
        {forCafe(t("of {name}", { name: cafe.name }))}
      </button>
    </form>
  );
}

function PaymentForm({ cafe, onSaved }: { cafe: AdminCafe; onSaved: (cafe: AdminCafe, notice: string) => void }) {
  const t = useT(AR);
  const lang = useLang();
  const forThis = forCafe(t("for {name}", { name: cafe.name }));
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  // Kept until the payment is recorded, so sending the form again after a lost response records it once.
  const [paymentId, setPaymentId] = useState(() => crypto.randomUUID());
  const [problems, setProblems] = useState<Record<string, string>>({});
  const titleId = `payment-title-${cafe.id}`;
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby={titleId}
      onSubmit={(event) => {
        event.preventDefault();
        const amountCents = parseUsdInput(amount);
        if (amountCents === null || amountCents < 1) {
          setProblems({ amountCents: t("Enter an amount in dollars over 0, such as 25 or 25.00.") });
          return;
        }
        setProblems({});
        void submit(() => apiRequest("POST", `/api/admin/cafes/${cafe.id}/payments`, adminCafeSchema, { paymentId, amountCents, paidOn, method, reference })).then((result) => {
          if (result.ok) {
            setAmount("");
            setReference("");
            setPaymentId(crypto.randomUUID());
            onSaved(
              result.value,
              t("Recorded {amount} from {name}, paid by {method} on {day}.", {
                amount: formatUsd(amountCents, "en"),
                name: cafe.name,
                method: t(METHOD_LABELS[method]),
                day: dateFormat(lang, DAY).format(new Date(paidOn)),
              }),
            );
          } else if (isStale(result.error)) {
            // Recorded already with other details (CONFLICT): what is in the form now is a new payment.
            setPaymentId(crypto.randomUUID());
          }
        });
      }}
    >
      <h4 id={titleId}>
        {t("Record a payment")}
        {forThis}
      </h4>
      <FormError message={error} />
      <Field
        label={
          <>
            {t("Amount (USD)")}
            {forThis}
          </>
        }
        name="amount"
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={setAmount}
        error={problems.amountCents ?? fieldErrors.amountCents}
      />
      <Field label={
          <>
            {t("Paid on")}
            {forThis}
          </>
        } name="paidOn" type="date" value={paidOn} onChange={setPaidOn} error={fieldErrors.paidOn} />
      <fieldset>
        <legend>
          {t("Paid by")}
          {forThis}
        </legend>
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
              <span lang={lang === "ar" && (option === "whish" || option === "omt") ? "en" : undefined}>{t(METHOD_LABELS[option])}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field
        label={
          <>
            {t("Reference")}
            {forThis}
          </>
        }
        name="reference"
        type="text"
        value={reference}
        onChange={setReference}
        maxLength={100}
        optional
        hint={t("Optional: a receipt or transfer number. No names or phone numbers.")}
        error={fieldErrors.reference}
      />
      <button type="submit" disabled={pending}>
        {pending ? t("Recording…") : t("Record payment")}
        {forThis}
      </button>
    </form>
  );
}

function CafeCard({ cafe, onSaved }: { cafe: AdminCafe; onSaved: (cafe: AdminCafe, notice: string) => void }) {
  const t = useT(AR);
  const dayFormat = dateFormat(useLang(), DAY);
  const titleId = `admin-cafe-${cafe.id}`;
  return (
    <li>
      <section aria-labelledby={titleId} className="card">
        <h3 id={titleId}>
          {cafe.name}
          <span className="visually-hidden">{t(", plan:")}</span>{" "}
          <span className={cafe.plan === "suspended" ? "badge badge-warning" : cafe.plan === "active" ? "badge badge-success" : "badge"}>{t(PLAN_LABELS[cafe.plan])}</span>
        </h3>
        <p className="hint">
          {t("Created {day}. Paid in all: {amount}.", { day: dayFormat.format(new Date(cafe.createdAt)), amount: formatUsd(cafe.paidCents, "en") })}
        </p>
        <PlanForm cafe={cafe} onSaved={onSaved} />
        <PaymentForm cafe={cafe} onSaved={onSaved} />
        {cafe.payments.length === 0 ? (
          <p className="empty">{t("No payments recorded yet.")}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>{t("Latest payments of {name}", { name: cafe.name })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("Paid on")}</th>
                  <th scope="col">{t("Amount")}</th>
                  <th scope="col">{t("By")}</th>
                  <th scope="col">{t("Reference")}</th>
                </tr>
              </thead>
              <tbody>
                {cafe.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{dayFormat.format(new Date(payment.paidOn))}</td>
                    <td>{formatUsd(payment.amountCents, "en")}</td>
                    <td>{t(METHOD_LABELS[payment.method])}</td>
                    <td>{payment.reference === null ? "—" : <bdi>{payment.reference}</bdi>}</td>
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
  const t = useT(AR);
  const [state, setData] = useApiData("/api/admin/cafes", adminCafesSchema);
  const [notice, setNotice] = useState<string | null>(null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const { cafes } = state.data;
  return (
    <section aria-labelledby="admin-cafes-title">
      <h2 id="admin-cafes-title" tabIndex={-1}>
        {t("Cafés")}
      </h2>
      <p className="page-intro">{t("Set each café's plan and record the payments it made. Every change goes in the café's audit log.")}</p>
      {notice === null ? null : <Notice>{notice}</Notice>}
      {cafes.length === 0 ? (
        <p className="empty">{t("No cafés yet. Create one with create-invite.")}</p>
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
  const t = useT(AR);
  const api = useApiText();
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
          setState({ status: "unavailable", message: failure instanceof Error ? failure.message : apiText("Something went wrong on this page. Reload it and try again.") });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  switch (state.status) {
    case "loading":
      return layout(<p role="status">{t("Loading…")}</p>, null);
    case "unavailable":
      return layout(
        <>
          <p role="alert" className="form-error">
            {api(state.message)}
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            {t("Try again")}
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
                <h3 id="admin-sign-out-title">{t("Sign out")}</h3>
                <p>{t("Signing out ends your operator session on every device.")}</p>
                <FormError message={error} />
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    void submit(() => apiRequest("POST", "/api/admin/logout", noContent)).then((result) => {
                      if (result.ok) {
                        signOut(t("You signed out on every device."));
                      }
                    });
                  }}
                >
                  {pending ? t("Signing out…") : t("Sign out")}
                </button>
              </section>
            </>,
            state.session,
          )}
        </SessionEndedContext.Provider>
      );
  }
}
