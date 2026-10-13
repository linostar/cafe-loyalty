import {
  CAFE_PLANS,
  PAYMENT_METHODS,
  adminCafeSchema,
  adminCafesSchema,
  adminInviteSchema,
  apiText,
  formatUsd,
  operatorSessionSchema,
  type AdminCafe,
  type AdminInvite,
  type CafePlan,
  type OperatorSession,
  type PaymentMethod,
  type Lang,
} from "@cafe-loyalty/shared";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, apiRequest, isStale } from "./api.js";
import { Field, FormError, Notice, useSubmit } from "./forms.js";
import { dateFormat, type Later, type Translate, useApiText, useLang, useT } from "./i18n.js";
import { parseUsdInput } from "./money-input.js";
import { ChangePasswordForm } from "./password-form.js";
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
  "Open a café to make its owner's signup link, set its plan or record a payment. Every change goes in the café's audit log.":
    "افتح مقهى لإنشاء رابط تسجيل مالكه أو تحديد خطته أو تسجيل دفعة. يُسجَّل كل تغيير في سجل تدقيق المقهى.",
  "All cafés": "كل المقاهي",
  "Open {name}": "افتح {name}",
  Account: "الحساب",
  "Signed in as {email}": "مسجّل الدخول باسم {email}",
  "No cafés yet.": "لا مقاهٍ بعد.",
  "New café": "مقهى جديد",
  "Café name": "اسم المقهى",
  "Creating…": "جارٍ الإنشاء…",
  "Create café": "إنشاء المقهى",
  "Creates the café on the pilot plan and a signup link for its owner.": "يُنشئ المقهى على الخطة التجريبية ورابط تسجيل لمالكه.",
  "New signup link": "رابط تسجيل جديد",
  "Making a link…": "جارٍ إنشاء الرابط…",
  "Owner signup link for {name}": "رابط تسجيل المالك لـ{name}",
  "Send it to the café's owner. It works once, until {day}, and is shown only now.": "أرسله إلى مالك المقهى. يعمل مرة واحدة حتى {day}، ولا يظهر إلا الآن.",
  "Copy link": "نسخ الرابط",
  "Copied.": "تم النسخ.",
  "Could not copy. Select the link and copy it.": "تعذّر النسخ. حدّد الرابط وانسخه.",
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

function PlanForm({ cafe, onSaved }: { cafe: AdminCafe; onSaved: (cafe: AdminCafe, notice: Later<typeof AR>) => void }) {
  const t = useT(AR);
  const [plan, setPlan] = useState<CafePlan>(cafe.plan);
  const { pending, error, submit } = useSubmit();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => apiRequest("PATCH", `/api/admin/cafes/${cafe.id}`, adminCafeSchema, { plan })).then((result) => {
          if (result.ok) {
            const plan = result.value.plan;
            onSaved(result.value, (say: Translate<typeof AR>) => say("{name} is now on the {plan} plan.", { name: cafe.name, plan: say(PLAN_LABELS[plan]).toLowerCase() }));
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

function PaymentForm({ cafe, onSaved }: { cafe: AdminCafe; onSaved: (cafe: AdminCafe, notice: Later<typeof AR>) => void }) {
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
              (say: Translate<typeof AR>, shownIn: Lang) =>
                say("Recorded {amount} from {name}, paid by {method} on {day}.", {
                  amount: formatUsd(amountCents, "en"),
                  name: cafe.name,
                  method: say(METHOD_LABELS[method]),
                  day: dateFormat(shownIn, DAY).format(new Date(paidOn)),
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

/** A new café's form; its id is kept until the café is created, so sending it again after a lost response creates it once. */
function NewCafeForm({ onCreated }: { onCreated: (invite: AdminInvite) => void }) {
  const t = useT(AR);
  const [name, setName] = useState("");
  const [cafeId, setCafeId] = useState(() => crypto.randomUUID());
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="admin-new-cafe-title"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => apiRequest("POST", "/api/admin/cafes", adminInviteSchema, { cafeId, name })).then((result) => {
          if (result.ok) {
            setName("");
            setCafeId(crypto.randomUUID());
            onCreated(result.value);
          } else if (isStale(result.error)) {
            // Created already with another name (CONFLICT): what is in the form now is a new café.
            setCafeId(crypto.randomUUID());
          }
        });
      }}
    >
      <FormError message={error} />
      <Field label={t("Café name")} name="cafeName" type="text" value={name} onChange={setName} maxLength={120} hint={t("Creates the café on the pilot plan and a signup link for its owner.")} error={fieldErrors.name} />
      <button type="submit" disabled={pending}>
        {pending ? t("Creating…") : t("Create café")}
      </button>
    </form>
  );
}

/** A signup link just made (keyed by it, so a fresh one starts afresh): the server keeps only its hash, so this is the one time it is shown. */
function InviteLink({ cafe, invite }: { cafe: AdminCafe; invite: AdminInvite }) {
  const t = useT(AR);
  const lang = useLang();
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"Copied." | "Could not copy. Select the link and copy it." | null>(null);
  const id = `invite-${cafe.id}`;
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <div className="field">
      <label htmlFor={id}>{t("Owner signup link for {name}", { name: cafe.name })}</label>
      <input
        id={id}
        ref={input}
        type="text"
        readOnly
        dir="ltr"
        value={invite.link}
        aria-describedby={`${id}-hint`}
        onFocus={(event) => {
          event.target.select();
        }}
      />
      <p id={`${id}-hint`} className="hint">
        {t("Send it to the café's owner. It works once, until {day}, and is shown only now.", { day: dateFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(invite.expiresAt)) })}
      </p>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(invite.link).then(
            () => {
              setCopied("Copied.");
            },
            () => {
              setCopied("Could not copy. Select the link and copy it.");
            },
          );
        }}
      >
        {t("Copy link")}
        {forCafe(t("for {name}", { name: cafe.name }))}
      </button>
      <p role="status">{copied === null ? null : t(copied)}</p>
    </div>
  );
}

function NewLinkButton({ cafe, onCreated }: { cafe: AdminCafe; onCreated: (invite: AdminInvite) => void }) {
  const t = useT(AR);
  const { pending, error, submit } = useSubmit();
  return (
    <div>
      <FormError message={error} />
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          void submit(() => apiRequest("POST", `/api/admin/cafes/${cafe.id}/invites`, adminInviteSchema, {})).then((result) => {
            if (result.ok) {
              onCreated(result.value);
            }
          });
        }}
      >
        {pending ? t("Making a link…") : t("New signup link")}
        {forCafe(t("for {name}", { name: cafe.name }))}
      </button>
    </div>
  );
}

/** The café's latest payments, newest first. */
function PaymentsTable({ cafe }: { cafe: AdminCafe }) {
  const t = useT(AR);
  const dayFormat = dateFormat(useLang(), DAY);
  return cafe.payments.length === 0 ? (
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
  );
}

const planBadge = (plan: CafePlan) => (plan === "suspended" ? "badge badge-warning" : plan === "active" ? "badge badge-success" : "badge");

function BackToList() {
  const t = useT(AR);
  return (
    <p>
      <a href="/admin">{t("All cafés")}</a>
    </p>
  );
}

/** `/admin`: every café as a tile linking to its page, and the way to a new one. */
function CafeListPage() {
  const t = useT(AR);
  const dayFormat = dateFormat(useLang(), DAY);
  const [state] = useApiData("/api/admin/cafes", adminCafesSchema);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const { cafes } = state.data;
  return (
    <section aria-labelledby="admin-cafes-title">
      <h2 id="admin-cafes-title" tabIndex={-1}>
        {t("Cafés")}
      </h2>
      <p className="page-intro">{t("Open a café to make its owner's signup link, set its plan or record a payment. Every change goes in the café's audit log.")}</p>
      <p>
        <a className="action-link" href="/admin/cafes/new">
          {t("New café")}
        </a>
      </p>
      {cafes.length === 0 ? (
        <p className="empty">{t("No cafés yet.")}</p>
      ) : (
        <ul className="tiles">
          {cafes.map((cafe) => (
            <li key={cafe.id}>
              <a href={`/admin/cafes/${cafe.id}`}>{cafe.name}</a>
              <p>
                <span className="visually-hidden">{t(", plan:")}</span>
                <span className={planBadge(cafe.plan)}>{t(PLAN_LABELS[cafe.plan])}</span>{" "}
                {t("Created {day}. Paid in all: {amount}.", { day: dayFormat.format(new Date(cafe.createdAt)), amount: formatUsd(cafe.paidCents, "en") })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `/admin/cafes/new`: the café's name, then its owner's signup link (shown once here) and the way to its page. */
function NewCafePage() {
  const t = useT(AR);
  const [invite, setInvite] = useState<AdminInvite | null>(null);
  return (
    <section aria-labelledby="admin-new-cafe-title">
      <BackToList />
      <h2 id="admin-new-cafe-title" tabIndex={-1}>
        {t("New café")}
      </h2>
      <NewCafeForm onCreated={setInvite} />
      {invite === null ? null : (
        <div className="card">
          <InviteLink key={invite.link} cafe={invite.cafe} invite={invite} />
          <p>
            <a href={`/admin/cafes/${invite.cafe.id}`}>{t("Open {name}", { name: invite.cafe.name })}</a>
          </p>
        </div>
      )}
    </section>
  );
}

/** `/admin/cafes/<id>`: one café's signup links, plan and payments. It is read from the café list (no route of its own). */
function CafeDetailPage({ cafeId }: { cafeId: string }) {
  const t = useT(AR);
  const api = useApiText();
  const lang = useLang();
  const dayFormat = dateFormat(lang, DAY);
  const [state, setData] = useApiData("/api/admin/cafes", adminCafesSchema);
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  const [invite, setInvite] = useState<AdminInvite | null>(null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const cafe = state.data.cafes.find((entry) => entry.id === cafeId);
  if (cafe === undefined) {
    return (
      <section aria-labelledby="admin-cafe-missing">
        <BackToList />
        <p id="admin-cafe-missing" role="alert" className="form-error">
          {api("This café no longer exists. Reload the list.")}
        </p>
      </section>
    );
  }
  const onSaved = (saved: AdminCafe, message: Later<typeof AR>) => {
    // From the latest list: another response may have landed since this render.
    setData((current) => ({ cafes: current.cafes.map((entry) => (entry.id === saved.id ? saved : entry)) }));
    setNotice(() => message);
  };
  const titleId = `admin-cafe-${cafe.id}`;
  return (
    <section aria-labelledby={titleId}>
      <BackToList />
      <h2 id={titleId} tabIndex={-1}>
        {cafe.name}
        <span className="visually-hidden">{t(", plan:")}</span> <span className={planBadge(cafe.plan)}>{t(PLAN_LABELS[cafe.plan])}</span>
      </h2>
      <p className="page-intro">
        {t("Created {day}. Paid in all: {amount}.", { day: dayFormat.format(new Date(cafe.createdAt)), amount: formatUsd(cafe.paidCents, "en") })}
      </p>
      {notice === null ? null : <Notice>{notice(t, lang)}</Notice>}
      <div className="card">
        {/* A link leaves the café as listed: its copy of it may be older than a plan or payment saved meanwhile. */}
        <NewLinkButton
          cafe={cafe}
          onCreated={(made) => {
            setNotice(null);
            setInvite(made);
          }}
        />
        {invite === null ? null : <InviteLink key={invite.link} cafe={cafe} invite={invite} />}
      </div>
      <div className="card">
        <PlanForm cafe={cafe} onSaved={onSaved} />
      </div>
      <div className="card">
        <PaymentForm cafe={cafe} onSaved={onSaved} />
        <PaymentsTable cafe={cafe} />
      </div>
    </section>
  );
}

/** `/admin/password`: the operator's own password; changing it ends every session of theirs. */
function PasswordPage({ session, onChanged }: { session: OperatorSession; onChanged: () => void }) {
  const t = useT(AR);
  return (
    <section aria-labelledby="admin-account-title">
      <BackToList />
      <h2 id="admin-account-title" tabIndex={-1}>
        {t("Account")}
      </h2>
      <p className="page-intro">{t("Signed in as {email}", { email: session.operator.email })}</p>
      <ChangePasswordForm path="/api/admin/password" onChanged={onChanged} />
    </section>
  );
}

const CAFE_PATH = /^\/admin\/cafes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The admin page for `path`; an unknown /admin path shows the café list. */
function AdminPage({ path, session, signOut }: { path: string; session: OperatorSession; signOut: (notice: string) => void }) {
  const cafeId = CAFE_PATH.exec(path)?.[1];
  if (cafeId !== undefined) {
    return <CafeDetailPage cafeId={cafeId} />;
  }
  switch (path) {
    case "/admin/cafes/new":
      return <NewCafePage />;
    case "/admin/password":
      return (
        <PasswordPage
          session={session}
          onChanged={() => {
            signOut("Your password is changed. Sign in with the new password.");
          }}
        />
      );
    default:
      return <CafeListPage />;
  }
}

type AdminState =
  | { status: "loading" }
  | { status: "signed-out"; notice: string | null }
  | { status: "signed-in"; session: OperatorSession }
  | { status: "unavailable"; message: string };

/**
 * `/admin` and its pages: the operator's screen (AC 39), behind its own sign-in. `layout` wraps every state in the
 * page's frame, with the way to sign out once signed in.
 */
export function AdminArea({
  path,
  layout,
}: {
  path: string;
  layout: (children: ReactNode, session: OperatorSession | null, signOut: (notice: string) => void) => ReactNode;
}) {
  const t = useT(AR);
  const api = useApiText();
  const [state, setState] = useState<AdminState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const signOut = useCallback((notice: string) => {
    setState({ status: "signed-out", notice });
  }, []);

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
      return layout(<p role="status">{t("Loading…")}</p>, null, signOut);
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
        signOut,
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
        signOut,
      );
    case "signed-in":
      return (
        <SessionEndedContext.Provider value={signOut}>
          {layout(<AdminPage path={path} session={state.session} signOut={signOut} />, state.session, signOut)}
        </SessionEndedContext.Provider>
      );
  }
}
