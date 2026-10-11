import {
  OWNER_PASSWORD_MIN_LENGTH,
  PRODUCT_NAME,
  VISIT_HOURS_WEEKS,
  apiText,
  cafeSetupSchema,
  ownerSessionSchema,
  plural,
  visitHoursSchema,
  walletDeliveriesSchema,
  type OperatorSession,
  type OwnerSession,
  type VisitHours as VisitHoursData,
} from "@cafe-loyalty/shared";
import logoUrl from "@cafe-loyalty/ui/logo.svg";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AdminArea } from "./admin-page.js";
import { ApiRequestError, apiRequest, noContent } from "./api.js";
import { ForgotPasswordPage, LoginForm, ResetPasswordPage, SignupPage } from "./auth-pages.js";
import { CafePage } from "./cafe-page.js";
import { CampaignsPage } from "./campaigns-page.js";
import { DevicesPage } from "./devices-page.js";
import { Field, FormError, useSubmit } from "./forms.js";
import { LangProvider, LanguageSwitch, dateFormat, useApiText, useLang, useT } from "./i18n.js";
import { InboxPage } from "./inbox-page.js";
import { ResultsPage } from "./results-page.js";
import { ReviewPage } from "./review-page.js";
import { PageStatus, SessionEndedContext, useApiData } from "./session.js";
import { StaffPage } from "./staff-page.js";

const AR = {
  Home: "الرئيسية",
  Café: "المقهى",
  Campaigns: "الحملات",
  Staff: "الموظفون",
  Devices: "الأجهزة",
  Review: "المراجعة",
  Inbox: "الوارد",
  Results: "النتائج",
  Account: "الحساب",
  Dashboard: "لوحة التحكم",
  Admin: "الإدارة",
  "Account: ": "الحساب: ",
  "Build {id}": "الإصدار {id}",
  "Change password": "تغيير كلمة المرور",
  "Changing your password signs you out everywhere, on this device too.": "تغيير كلمة المرور يسجّل خروجك من كل مكان، ومن هذا الجهاز أيضاً.",
  "Current password": "كلمة المرور الحالية",
  "New password": "كلمة المرور الجديدة",
  "At least {n} characters.": "{n} أحرف على الأقل.",
  "Could not check wallet card updates: {message}": "تعذّر التحقق من تحديثات بطاقات المحفظة: {message}",
  "Wallet card updates are failing": "تحديثات بطاقات المحفظة تفشل",
  "Some customers' wallet cards are not showing their latest stamps:": "بطاقات المحفظة لدى بعض الزبائن لا تُظهر أحدث أختامهم:",
  "{wallet}: {cards}, last failure {time} (code {code})": "{wallet}: {cards}، آخر فشل {time} (الرمز {code})",
  "Apple Wallet": "Apple Wallet",
  "Google Wallet": "محفظة Google",
  "Stamps are still saved, and the server keeps retrying these cards every 15 minutes: they catch up, and this notice goes away, once updates go through again. If it is still here after a day, contact support with the codes above.":
    "الأختام لا تزال محفوظة، ويعيد الخادم محاولة تحديث هذه البطاقات كل 15 دقيقة: تلحق البطاقات بالتحديثات ويختفي هذا التنبيه حين تنجح مجدداً. إذا بقي هنا بعد يوم، فتواصل مع الدعم واذكر الرموز أعلاه.",
  "Could not check your café's plan: {message}": "تعذّر التحقق من خطة مقهاك: {message}",
  "Your café's plan is suspended": "خطة مقهاك موقوفة",
  "New customers cannot join from your signup QR. Your counter still records stamps and rewards for existing cards. Contact us to reactivate it.":
    "لا يمكن لزبائن جدد الانضمام عبر رمز QR للتسجيل. لا يزال الكاونتر يسجّل الأختام والمكافآت للبطاقات الحالية. تواصل معنا لإعادة تفعيل الخطة.",
  "Busy and quiet hours": "ساعات الذروة والهدوء",
  "Members only: visits recorded with a loyalty card over the last {weeks} weeks, by the hour they happened in café time. Updated every hour.":
    "الأعضاء فقط: الزيارات المسجّلة ببطاقة ولاء خلال آخر {weeks} أسابيع، حسب ساعة حدوثها بتوقيت المقهى. تُحدَّث كل ساعة.",
  "Members only: visits recorded with a loyalty card over the last {weeks} weeks, by the hour they happened in café time ({zone}). Updated every hour.":
    "الأعضاء فقط: الزيارات المسجّلة ببطاقة ولاء خلال آخر {weeks} أسابيع، حسب ساعة حدوثها بتوقيت المقهى ({zone}). تُحدَّث كل ساعة.",
  "Could not load the busy and quiet hours: {message} This page tries again in 5 minutes.": "تعذّر تحميل ساعات الذروة والهدوء: {message} ستحاول هذه الصفحة مجدداً بعد 5 دقائق.",
  "Could not update these hours: {message} Showing the last ones loaded; this page tries again in 5 minutes.":
    "تعذّر تحديث هذه الساعات: {message} نعرض آخر ما حُمّل؛ ستحاول هذه الصفحة مجدداً بعد 5 دقائق.",
  "No member visits in the last {weeks} weeks yet.": "لا زيارات أعضاء خلال آخر {weeks} أسابيع بعد.",
  "Member visits by hour and weekday": "زيارات الأعضاء حسب الساعة ويوم الأسبوع",
  Hour: "الساعة",
  Quiet: "هادئ",
  Busy: "مزدحم",
  "Signed in as {email}": "مسجّل الدخول باسم {email}",
  "Name, loyalty program, margin and order types.": "الاسم وبرنامج الولاء والهامش وأنواع الطلبات.",
  "Discounts at quiet hours, above your minimum margin.": "خصومات في ساعات الهدوء، فوق الحد الأدنى لهامشك.",
  "Baristas and their PINs.": "الباريستا ورموزهم السرية.",
  "Pair or remove counter phones.": "اربط هواتف الكاونتر أو أزلها.",
  "What removed phones and baristas recorded.": "ما سجّلته هواتف وباريستا أُزيلوا.",
  "Private feedback from your customers.": "ملاحظات خاصة من زبائنك.",
  "Your first month: customers won back, quiet-hour visits and what offers cost.": "شهرك الأول: الزبائن المسترجَعون، وزيارات ساعات الهدوء، وكلفة العروض.",
  "Password and signing out.": "كلمة المرور وتسجيل الخروج.",
  "Sign out": "تسجيل الخروج",
  "Signing out ends your session on every device.": "تسجيل الخروج ينهي جلستك على كل الأجهزة.",
  "Signing out…": "جارٍ تسجيل الخروج…",
} as const;

type SessionState =
  | { status: "loading" }
  | { status: "signed-out"; notice: string | null }
  | { status: "signed-in"; session: OwnerSession }
  | { status: "unavailable"; message: string };

/** The signed-in pages, by path; each is behind the session gate. */
const OWNER_PAGES = [
  { path: "/", label: "Home" },
  { path: "/cafe", label: "Café" },
  { path: "/campaigns", label: "Campaigns" },
  { path: "/staff", label: "Staff" },
  { path: "/devices", label: "Devices" },
  { path: "/review", label: "Review" },
  { path: "/inbox", label: "Inbox" },
  { path: "/results", label: "Results" },
  { path: "/account", label: "Account" },
] as const;

type OwnerPath = (typeof OWNER_PAGES)[number]["path"];

const isOwnerPath = (path: string): path is OwnerPath => OWNER_PAGES.some((page) => page.path === path);

function ChangePasswordForm({ onChanged }: { onChanged: () => void }) {
  const t = useT(AR);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();

  return (
    <section aria-labelledby="password-title" className="card">
      <h3 id="password-title">{t("Change password")}</h3>
      <p>{t("Changing your password signs you out everywhere, on this device too.")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(() => apiRequest("POST", "/api/auth/password", noContent, { currentPassword, newPassword })).then((result) => {
            if (result.ok) {
              onChanged();
            }
          });
        }}
      >
        <FormError message={error} />
        <Field
          label={t("Current password")}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
          error={fieldErrors.currentPassword}
        />
        <Field
          label={t("New password")}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={setNewPassword}
          hint={t("At least {n} characters.", { n: OWNER_PASSWORD_MIN_LENGTH })}
          minLength={OWNER_PASSWORD_MIN_LENGTH}
          error={fieldErrors.newPassword}
        />
        <button type="submit" disabled={pending}>
          {pending ? t("Saving…") : t("Change password")}
        </button>
      </form>
    </section>
  );
}

const WALLET_NAMES = { apple: "Apple Wallet", google: "Google Wallet" } as const;
const CARDS = { en: { one: "{n} card", other: "{n} cards" }, ar: { one: "بطاقة واحدة", two: "بطاقتان", few: "{n} بطاقات", other: "{n} بطاقة" } };

/**
 * Warns when customers' wallet cards keep failing to update (AC 13); shows nothing while all goes through. The worker
 * retries undelivered passes every 15 minutes, so the notice clears itself once updates succeed again.
 */
function WalletDeliveryNotice() {
  const t = useT(AR);
  const api = useApiText();
  const lang = useLang();
  const [state] = useApiData("/api/cafe/wallet-deliveries", walletDeliveriesSchema);
  if (state.status === "loading") {
    return null;
  }
  if (state.status === "failed") {
    return (
      <p role="alert" className="form-error">
        {t("Could not check wallet card updates: {message}", { message: api(state.message) })}
      </p>
    );
  }
  if (state.data.failing.length === 0) {
    return null;
  }
  const failureTime = dateFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  // Part of the page rather than a live alert, so screen readers do not announce it again on every visit.
  return (
    <section aria-labelledby="wallet-updates-title" className="form-error">
      <h3 id="wallet-updates-title">{t("Wallet card updates are failing")}</h3>
      <p>{t("Some customers' wallet cards are not showing their latest stamps:")}</p>
      <ul>
        {state.data.failing.map((entry) => (
          <li key={entry.wallet}>
            {t("{wallet}: {cards}, last failure {time} (code {code})", {
              wallet: t(WALLET_NAMES[entry.wallet]),
              cards: plural(lang, CARDS, entry.passes),
              time: failureTime.format(new Date(entry.lastFailedAt)),
              code: entry.lastError,
            })}
          </li>
        ))}
      </ul>
      <p>
        {t(
          "Stamps are still saved, and the server keeps retrying these cards every 15 minutes: they catch up, and this notice goes away, once updates go through again. If it is still here after a day, contact support with the codes above.",
        )}
      </p>
    </section>
  );
}

/** Says when the operator suspended the café (AC 39), so the owner knows why nobody can join; nothing otherwise. */
function PlanNotice() {
  const t = useT(AR);
  const api = useApiText();
  const [state] = useApiData("/api/cafe", cafeSetupSchema);
  if (state.status === "failed") {
    return (
      <p role="alert" className="form-error">
        {t("Could not check your café's plan: {message}", { message: api(state.message) })}
      </p>
    );
  }
  if (state.status !== "loaded" || state.data.cafe.plan !== "suspended") {
    return null;
  }
  return (
    <section aria-labelledby="plan-notice-title" className="form-error">
      <h3 id="plan-notice-title">{t("Your café's plan is suspended")}</h3>
      <p>
        {t(
          "New customers cannot join from your signup QR. Your counter still records stamps and rewards for existing cards. Contact us to reactivate it.",
        )}
      </p>
    </section>
  );
}

/** Monday to Sunday, as the days of a week that starts on a Monday (5 January 2026), for their names in each language. */
const WEEK = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2026, 0, 5 + index)));
/** The busy and quiet hours load again this often while the page stays open (AC 34)... */
const VISIT_HOURS_REFRESH_MS = 60 * 60 * 1000;
/** ...and this soon after a load that failed. */
const VISIT_HOURS_RETRY_MS = 5 * 60 * 1000;

/**
 * Busy and quiet hours (AC 34): member visits of the last weeks by hour and weekday, in the café's time zone, as a
 * table shaded from quiet to busy. Hours before the first and after the last hour with any visit are left out. A
 * reload that fails keeps the hours already shown, says so without an alert (the owner did nothing), and is tried
 * again sooner.
 */
function VisitHours() {
  const t = useT(AR);
  const api = useApiText();
  const lang = useLang();
  const [reloadKey, setReloadKey] = useState(0);
  const [state] = useApiData("/api/cafe/visit-hours", visitHoursSchema, reloadKey);
  const failed = state.status === "failed";
  // Re-armed by every load and by every change between failing and not, so the next one waits the right time.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        setReloadKey((key) => key + 1);
      },
      failed ? VISIT_HOURS_RETRY_MS : VISIT_HOURS_REFRESH_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [reloadKey, failed]);
  // The last hours loaded, kept while a reload fails (state from an earlier render, set during this one).
  const [lastLoaded, setLastLoaded] = useState<VisitHoursData | null>(null);
  if (state.status === "loaded" && state.data !== lastLoaded) {
    setLastLoaded(state.data);
  }
  const data = state.status === "loaded" ? state.data : lastLoaded;
  const busiest = data === null ? 0 : Math.max(...data.visits.flat());
  const hours = data === null ? [] : [...Array(24).keys()].filter((hour) => data.visits.some((day) => (day[hour] ?? 0) > 0));
  const first = hours[0] ?? 0;
  const shown = [...Array((hours.at(-1) ?? -1) - first + 1).keys()].map((offset) => first + offset);
  const shortDay = dateFormat(lang, { weekday: "short", timeZone: "UTC" });
  const longDay = dateFormat(lang, { weekday: "long", timeZone: "UTC" });
  const weeks = { weeks: VISIT_HOURS_WEEKS };
  return (
    <section aria-labelledby="visit-hours-title" className="card">
      <h3 id="visit-hours-title">{t("Busy and quiet hours")}</h3>
      <p className="hint">
        {data === null
          ? t("Members only: visits recorded with a loyalty card over the last {weeks} weeks, by the hour they happened in café time. Updated every hour.", weeks)
          : t("Members only: visits recorded with a loyalty card over the last {weeks} weeks, by the hour they happened in café time ({zone}). Updated every hour.", {
              ...weeks,
              zone: data.timeZone,
            })}
      </p>
      {state.status === "failed" ? (
        data === null ? (
          <p role="alert" className="form-error">
            {t("Could not load the busy and quiet hours: {message} This page tries again in 5 minutes.", { message: api(state.message) })}
          </p>
        ) : (
          <p className="form-error">
            {t("Could not update these hours: {message} Showing the last ones loaded; this page tries again in 5 minutes.", { message: api(state.message) })}
          </p>
        )
      ) : null}
      {data === null ? (
        state.status === "loading" ? (
          <PageStatus state={state} />
        ) : null
      ) : shown.length === 0 ? (
        <p className="empty">{t("No member visits in the last {weeks} weeks yet.", weeks)}</p>
      ) : (
        <div className="visit-hours">
          <table>
            <caption className="visually-hidden">{t("Member visits by hour and weekday")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("Hour")}</th>
                {WEEK.map((day) => (
                  <th scope="col" key={day.getTime()}>
                    <abbr title={longDay.format(day)}>{shortDay.format(day)}</abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((hour) => (
                <tr key={hour}>
                  <th scope="row">{`${String(hour).padStart(2, "0")}:00`}</th>
                  {data.visits.map((day, weekday) => {
                    const visits = day[hour] ?? 0;
                    return (
                      <td key={WEEK[weekday]?.getTime()} className={`level-${String(Math.ceil((visits / busiest) * 4))}`}>
                        {visits}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {/* The shades only repeat the numbers in the cells, so the legend is for the eye. */}
          <p className="heat-legend" aria-hidden="true">
            {t("Quiet")}
            {[1, 2, 3, 4].map((level) => (
              <span key={level} className={`heat-swatch level-${String(level)}`} />
            ))}
            {t("Busy")}
          </p>
        </div>
      )}
    </section>
  );
}

const TILES = [
  { path: "/cafe", label: "Café", text: "Name, loyalty program, margin and order types." },
  { path: "/campaigns", label: "Campaigns", text: "Discounts at quiet hours, above your minimum margin." },
  { path: "/staff", label: "Staff", text: "Baristas and their PINs." },
  { path: "/devices", label: "Devices", text: "Pair or remove counter phones." },
  { path: "/review", label: "Review", text: "What removed phones and baristas recorded." },
  { path: "/inbox", label: "Inbox", text: "Private feedback from your customers." },
  { path: "/results", label: "Results", text: "Your first month: customers won back, quiet-hour visits and what offers cost." },
  { path: "/account", label: "Account", text: "Password and signing out." },
] as const;

function HomePage({ session }: { session: OwnerSession }) {
  const t = useT(AR);
  return (
    <section aria-labelledby="cafe-title">
      <h2 id="cafe-title">{session.cafe.name}</h2>
      <p className="page-intro">{t("Signed in as {email}", { email: session.owner.email })}</p>
      <PlanNotice />
      <WalletDeliveryNotice />
      <VisitHours />
      <ul className="tiles">
        {TILES.map((tile) => (
          <li key={tile.path}>
            <a href={tile.path}>{t(tile.label)}</a>
            <p>{t(tile.text)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccountPage({ onSignedOut }: { onSignedOut: (notice: string) => void }) {
  const t = useT(AR);
  const { pending, error, submit } = useSubmit();
  return (
    <>
      <h2 id="account-page-title">{t("Account")}</h2>
      <section aria-labelledby="account-title" className="card">
        <h3 id="account-title">{t("Sign out")}</h3>
        <p>{t("Signing out ends your session on every device.")}</p>
        <FormError message={error} />
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            void submit(() => apiRequest("POST", "/api/auth/logout", noContent)).then((result) => {
              if (result.ok) {
                onSignedOut("You signed out on every device.");
              }
            });
          }}
        >
          {pending ? t("Signing out…") : t("Sign out")}
        </button>
      </section>
      <ChangePasswordForm
        onChanged={() => {
          onSignedOut("Your password is changed. Sign in with the new password.");
        }}
      />
    </>
  );
}

function OwnerNav({ path }: { path: OwnerPath }) {
  const t = useT(AR);
  return (
    <nav aria-label={t("Dashboard")} className="sidenav">
      <ul>
        {OWNER_PAGES.map((page) => (
          <li key={page.path}>
            <a href={page.path} aria-current={page.path === path ? "page" : undefined}>
              {t(page.label)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The product's mark and name: the page's one h1, also the window's title. */
function Brand({ app = "Dashboard" }: { app?: "Dashboard" | "Admin" | undefined }) {
  const t = useT(AR);
  const appName = t(app);
  useEffect(() => {
    document.title = `${PRODUCT_NAME} ${appName}`;
  }, [appName]);
  return (
    <div className="brand">
      <img src={logoUrl} alt="" width={36} height={36} />
      <h1>
        {/* The product name is a Latin brand in both languages. */}
        <span lang="en" dir="ltr">
          {PRODUCT_NAME}
        </span>{" "}
        <span className="brand-app">{appName}</span>
      </h1>
    </div>
  );
}

function BuildFooter() {
  const t = useT(AR);
  return (
    <footer className="app-footer">
      <p>{t("Build {id}", { id: __BUILD_ID__ })}</p>
    </footer>
  );
}

/** The pages before a session (sign-in, signup, password reset, the session check): one card, centred, the brand above it. */
function AuthLayout({ children, app }: { children: ReactNode; app?: "Admin" }) {
  return (
    <div className="auth-layout">
      <header>
        <Brand app={app} />
        <LanguageSwitch />
      </header>
      <main className="card auth-card">{children}</main>
      <BuildFooter />
    </div>
  );
}

/** The signed-in pages: the top bar with the café, the account and the language, the navigation, then the page. */
function OwnerLayout({ session, path, children }: { session: OwnerSession; path: OwnerPath; children: ReactNode }) {
  const t = useT(AR);
  return (
    <div className="owner-layout">
      <header className="topbar">
        <Brand />
        <div className="topbar-end">
          <p className="topbar-account">
            <span className="topbar-cafe">{session.cafe.name}</span>
            <a href="/account" className="topbar-email" aria-current={path === "/account" ? "page" : undefined}>
              <span className="visually-hidden">{t("Account: ")}</span>
              <bdi>{session.owner.email}</bdi>
            </a>
          </p>
          <LanguageSwitch />
        </div>
      </header>
      <OwnerNav path={path} />
      <main className="owner-main">{children}</main>
      <BuildFooter />
    </div>
  );
}

/** The operator's screen: the top bar with their email and the language, then the page, without the owner's navigation. */
function AdminLayout({ session, children }: { session: OperatorSession; children: ReactNode }) {
  return (
    <div className="owner-layout admin-layout">
      <header className="topbar">
        <Brand app="Admin" />
        <div className="topbar-end">
          <p className="topbar-account">
            <bdi className="topbar-email">{session.operator.email}</bdi>
          </p>
          <LanguageSwitch />
        </div>
      </header>
      <main className="owner-main">{children}</main>
      <BuildFooter />
    </div>
  );
}

/** The owner's pages: checks the session once, shows sign-in when there is none, and the page with its nav when there is. */
function OwnerArea({ path }: { path: OwnerPath }) {
  const t = useT(AR);
  const api = useApiText();
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const signOut = useCallback((notice: string) => {
    setState({ status: "signed-out", notice });
  }, []);

  useEffect(() => {
    let current = true;
    apiRequest("GET", "/api/auth/session", ownerSessionSchema).then(
      (session) => {
        if (current) {
          setState({ status: "signed-in", session });
        }
      },
      (error: unknown) => {
        if (!current) {
          return;
        }
        if (error instanceof ApiRequestError && error.failure.code === "UNAUTHENTICATED") {
          setState({ status: "signed-out", notice: null });
        } else {
          setState({ status: "unavailable", message: error instanceof Error ? error.message : apiText("Something went wrong on this page. Reload it and try again.") });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  let content: ReactNode;
  switch (state.status) {
    case "loading":
      return (
        <AuthLayout>
          <p role="status">{t("Loading…")}</p>
        </AuthLayout>
      );
    case "unavailable":
      return (
        <AuthLayout>
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
        </AuthLayout>
      );
    case "signed-out":
      return (
        <AuthLayout>
          <LoginForm
            notice={state.notice}
            onSignedIn={(session) => {
              setState({ status: "signed-in", session });
            }}
          />
        </AuthLayout>
      );
    case "signed-in":
      switch (path) {
        case "/":
          content = <HomePage session={state.session} />;
          break;
        case "/cafe":
          content = <CafePage />;
          break;
        case "/campaigns":
          content = <CampaignsPage />;
          break;
        case "/staff":
          content = <StaffPage />;
          break;
        case "/devices":
          content = <DevicesPage />;
          break;
        case "/review":
          content = <ReviewPage />;
          break;
        case "/inbox":
          content = <InboxPage />;
          break;
        case "/results":
          content = <ResultsPage />;
          break;
        case "/account":
          content = <AccountPage onSignedOut={signOut} />;
          break;
      }
      return (
        <SessionEndedContext.Provider value={signOut}>
          <OwnerLayout session={state.session} path={path}>
            {content}
          </OwnerLayout>
        </SessionEndedContext.Provider>
      );
  }
}

function Page({ path }: { path: string }) {
  switch (path) {
    case "/signup":
      return (
        <AuthLayout>
          <SignupPage />
        </AuthLayout>
      );
    case "/forgot-password":
      return (
        <AuthLayout>
          <ForgotPasswordPage />
        </AuthLayout>
      );
    case "/reset-password":
      return (
        <AuthLayout>
          <ResetPasswordPage />
        </AuthLayout>
      );
    case "/admin":
      return (
        <AdminArea
          layout={(children, session) =>
            session === null ? <AuthLayout app="Admin">{children}</AuthLayout> : <AdminLayout session={session}>{children}</AdminLayout>
          }
        />
      );
    default:
      return <OwnerArea path={isOwnerPath(path) ? path : "/"} />;
  }
}

export function App() {
  return (
    <LangProvider>
      <Page path={window.location.pathname} />
    </LangProvider>
  );
}
