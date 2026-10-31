import {
  PRODUCT_NAME,
  VISIT_HOURS_WEEKS,
  apiText,
  cafeSetupSchema,
  devicesSchema,
  feedbackInboxSchema,
  ownerSessionSchema,
  plural,
  resultsReportSchema,
  reviewQueueSchema,
  visitHoursSchema,
  walletDeliveriesSchema,
  type OperatorSession,
  type Devices,
  type OwnerSession,
  type ReviewQueue,
  type VisitHours as VisitHoursData,
} from "@cafe-loyalty/shared";
import logoUrl from "@cafe-loyalty/ui/logo.svg";
import { useCallback, useContext, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { AdminArea } from "./admin-page.js";
import { ApiRequestError, apiRequest } from "./api.js";
import { ForgotPasswordPage, LoginForm, ResetPasswordPage, SignupPage } from "./auth-pages.js";
import { CafePage } from "./cafe-page.js";
import { CampaignsPage } from "./campaigns-page.js";
import { DevicesPage } from "./devices-page.js";
import { useFocusOnChange } from "./forms.js";
import { LangProvider, LanguageSwitch, dateFormat, useApiText, useCommonT, useLang, useT } from "./i18n.js";
import { InboxPage } from "./inbox-page.js";
import { ResultsPage } from "./results-page.js";
import { ReviewPage } from "./review-page.js";
import { PrintQrPage, SetupChecklist, SetupWizard } from "./setup.js";
import { ProfileMenu } from "./profile-menu.js";
import { ChangePasswordForm } from "./password-form.js";
import { AttentionContext, PageStatus, SessionEndedContext, useApiData, type ApiData } from "./session.js";
import { StaffPage } from "./staff-page.js";

const AR = {
  "Skip to content": "انتقل إلى المحتوى",
  "Page not found": "الصفحة غير موجودة",
  "There is no page at this address. Check it, or go to Home.": "لا توجد صفحة على هذا العنوان. تحقق منه، أو اذهب إلى الرئيسية.",
  "Go to Home": "الذهاب إلى الرئيسية",
  "You are offline. Pages cannot load and changes cannot be saved until the connection is back.":
    "أنت غير متصل بالإنترنت. لا يمكن تحميل الصفحات ولا حفظ التغييرات حتى يعود الاتصال.",
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
  "Build {id}": "الإصدار {id}",
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
  "Could not check your café's setup: {message}": "تعذّر التحقق من تجهيز مقهاك: {message}",
  More: "المزيد",
  "{count} waiting": "{count} بالانتظار",
  "{count} or more waiting": "{count} أو أكثر بالانتظار",
  "{count} unread": "{count} غير مقروءة",
  "Needs you": "بانتظارك",
  "Visits and actions held for you to check": "زيارات وإجراءات محجوزة لتتحقق منها",
  "Review them": "راجعها",
  "Unread messages from customers": "رسائل غير مقروءة من الزبائن",
  "Read them": "اقرأها",
  "Counter phones not seen for 2 days": "هواتف كاونتر لم تظهر منذ يومين",
  "Check them": "تحقق منها",
  "Nothing needs you right now.": "لا شيء بانتظارك الآن.",
  "Could not check what is held for review: {message}": "تعذّر التحقق مما هو محجوز للمراجعة: {message}",
  "Could not check your messages: {message}": "تعذّر التحقق من رسائلك: {message}",
  "Could not check your counter phones: {message}": "تعذّر التحقق من هواتف الكاونتر: {message}",
  "This month so far": "هذا الشهر حتى الآن",
  "Member visits": "زيارات الأعضاء",
  "Customers won back": "زبائن مسترجَعون",
  "Quiet-hour visits": "زيارات ساعات الهدوء",
  "Rewards redeemed": "المكافآت المستبدلة",
  "See all results": "كل النتائج",
  "Could not load this month's results: {message}": "تعذّر تحميل نتائج هذا الشهر: {message}",
} as const;

type SessionState =
  | { status: "loading" }
  | { status: "signed-out"; notice: string | null }
  | { status: "signed-in"; session: OwnerSession }
  | { status: "unavailable"; message: string };

/**
 * The navigation: the pages an owner opens daily, always in view (a row on a phone), then the setup pages, behind More
 * on a phone. The account is in the profile menu.
 */
const DAILY_PAGES = [
  { path: "/", label: "Home" },
  { path: "/review", label: "Review" },
  { path: "/inbox", label: "Inbox" },
] as const;
const MORE_PAGES = [
  { path: "/results", label: "Results" },
  { path: "/cafe", label: "Café" },
  { path: "/campaigns", label: "Campaigns" },
  { path: "/staff", label: "Staff" },
  { path: "/devices", label: "Devices" },
] as const;

/** The signed-in pages, by path; each is behind the session gate. */
const OWNER_PAGES = [
  { path: "/", label: "Home" },
  { path: "/cafe", label: "Café" },
  { path: "/cafe/print-qr", label: "Café" },
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
  const [state, , retry] = useApiData("/api/cafe/visit-hours", visitHoursSchema, reloadKey);
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
          <PageStatus state={state} onRetry={retry} />
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

/** A count beside a navigation link or a line of Home: the number for the eye, its meaning for screen readers. */
function Count({ count, more = false, label }: { count: number; more?: boolean; label: string }) {
  return (
    <>
      <span className="count-badge" aria-hidden="true">
        {more ? `${String(count)}+` : count}
      </span>
      <span className="visually-hidden"> {label}</span>
    </>
  );
}

/** The review queue's count: the items of its first page, "N+" (and "N or more" in words) when it has more pages. */
function ReviewCount({ queue }: { queue: ReviewQueue }) {
  const t = useT(AR);
  const count = queue.items.length;
  const more = queue.nextCursor !== null;
  return <Count count={count} more={more} label={more ? t("{count} or more waiting", { count }) : t("{count} waiting", { count })} />;
}

/** A paired phone that has not synced for this long has likely stopped recording (a sync moves its last seen time). */
const PHONE_QUIET_MS = 2 * 24 * 60 * 60 * 1000;
const PHONES = { en: { one: "{n} phone", other: "{n} phones" }, ar: { one: "هاتف واحد", two: "هاتفان", few: "{n} هواتف", other: "{n} هاتف" } };

/**
 * What needs the owner now: held items, unread messages and quiet counter phones, each with its count and a link to act.
 * `devices` is Home's own load, shared with the setup checklist.
 */
function NeedsYou({ devices }: { devices: ApiData<Devices> }) {
  const t = useT(AR);
  const api = useApiText();
  const lang = useLang();
  const { review, inbox } = useContext(AttentionContext);
  // As Home opened: the page loads again when the owner comes back to it.
  const [openedAt] = useState(() => Date.now());
  const held = review.status === "loaded" ? review.data.items.length : 0;
  const unread = inbox.status === "loaded" ? inbox.data.unread : 0;
  const quiet =
    devices.status === "loaded" ? devices.data.devices.filter((device) => !device.revoked && openedAt - Date.parse(device.lastSeenAt) >= PHONE_QUIET_MS).length : 0;
  const settled = review.status !== "loading" && inbox.status !== "loading" && devices.status !== "loading";
  return (
    <section aria-labelledby="needs-you-title" className="card">
      <h3 id="needs-you-title">{t("Needs you")}</h3>
      {review.status === "failed" ? <p className="form-error">{t("Could not check what is held for review: {message}", { message: api(review.message) })}</p> : null}
      {inbox.status === "failed" ? <p className="form-error">{t("Could not check your messages: {message}", { message: api(inbox.message) })}</p> : null}
      {devices.status === "failed" ? <p className="form-error">{t("Could not check your counter phones: {message}", { message: api(devices.message) })}</p> : null}
      {held > 0 || unread > 0 || quiet > 0 ? (
        <ul className="attention">
          {review.status === "loaded" && held > 0 ? (
            <li>
              <ReviewCount queue={review.data} />
              <span className="attention-text">{t("Visits and actions held for you to check")}</span>
              <a className="action-link" href="/review">
                {t("Review them")}
              </a>
            </li>
          ) : null}
          {unread > 0 ? (
            <li>
              <Count count={unread} label={t("{count} unread", { count: unread })} />
              <span className="attention-text">{t("Unread messages from customers")}</span>
              <a className="action-link" href="/inbox">
                {t("Read them")}
              </a>
            </li>
          ) : null}
          {quiet > 0 ? (
            <li>
              <Count count={quiet} label={plural(lang, PHONES, quiet)} />
              <span className="attention-text">{t("Counter phones not seen for 2 days")}</span>
              <a className="action-link" href="/devices">
                {t("Check them")}
              </a>
            </li>
          ) : null}
        </ul>
      ) : settled && review.status === "loaded" && inbox.status === "loaded" && devices.status === "loaded" ? (
        <p className="hint">{t("Nothing needs you right now.")}</p>
      ) : null}
    </section>
  );
}

/** This month's main figures so far, in café time (AC 38), with a link to the full results. */
function FirstMonth() {
  const t = useT(AR);
  const api = useApiText();
  const [state, , retry] = useApiData("/api/results", resultsReportSchema);
  return (
    <section aria-labelledby="first-month-title" className="card">
      <h3 id="first-month-title">{t("This month so far")}</h3>
      {state.status === "failed" ? (
        <p className="form-error">{t("Could not load this month's results: {message}", { message: api(state.message) })}</p>
      ) : state.status === "loading" ? (
        <PageStatus state={state} onRetry={retry} />
      ) : (
        <ul className="stats">
          {(
            [
              ["Member visits", state.data.memberVisits],
              ["Customers won back", state.data.customersWonBack],
              ["Quiet-hour visits", state.data.quietHourVisits],
              ["Rewards redeemed", state.data.rewardRedemptions],
            ] as const
          ).map(([label, value]) => (
            <li key={label}>
              <p className="stat-value">{value}</p>
              <p>{t(label)}</p>
            </li>
          ))}
        </ul>
      )}
      <p>
        <a className="action-link" href="/results">
          {t("See all results")}
        </a>
      </p>
    </section>
  );
}

/**
 * Home: the setup wizard until the café's setup is finished or skipped (D1), then the café at a glance, with the setup
 * checklist until every step is done (D22).
 */
function HomePage({ session }: { session: OwnerSession }) {
  const t = useT(AR);
  const common = useCommonT();
  const api = useApiText();
  const [setup, setSetup, retry] = useApiData("/api/cafe", cafeSetupSchema);
  // Loaded once, for the wizard, or the checklist and Needs you.
  const [devicesKey, setDevicesKey] = useState(0);
  const [devices, , retryDevices] = useApiData("/api/devices", devicesSchema, devicesKey);
  // Set when the wizard closes on this page: focus goes from its last button to Home's heading.
  const [wizardClosed, setWizardClosed] = useState(false);
  const home = useFocusOnChange<HTMLElement>(wizardClosed);
  if (setup.status === "loading") {
    return <PageStatus state={setup} onRetry={retry} />;
  }
  if (setup.status === "loaded" && setup.data.cafe.setupFinishedAt === null) {
    return (
      <SetupWizard
        setup={setup.data}
        devices={devices}
        reloadDevices={() => {
          setDevicesKey((key) => key + 1);
        }}
        retryDevices={retryDevices}
        onSetup={(next) => {
          // A step's save or a print answered after Finish carries the setup from before it: the finish stays.
          setSetup((current) =>
            next.cafe.setupFinishedAt === null && typeof current.cafe.setupFinishedAt === "string"
              ? { ...next, cafe: { ...next.cafe, setupFinishedAt: current.cafe.setupFinishedAt } }
              : next,
          );
          setWizardClosed((closed) => closed || next.cafe.setupFinishedAt !== null);
        }}
      />
    );
  }
  return (
    <section ref={home} aria-labelledby="cafe-title" className="home">
      <h2 id="cafe-title" tabIndex={-1} data-focus-target>
        {session.cafe.name}
      </h2>
      <p className="page-intro">{t("Signed in as {email}", { email: session.owner.email })}</p>
      <PlanNotice />
      <WalletDeliveryNotice />
      {setup.status === "failed" ? (
        <>
          <p className="form-error">{t("Could not check your café's setup: {message}", { message: api(setup.message) })}</p>
          {/* Loads it again in place: a new café's wizard comes back without reloading the page. */}
          <button type="button" className="primary" onClick={retry}>
            {common("Try again")}
          </button>
        </>
      ) : // A server from before the wizard sends no setupFinishedAt: no checklist then.
      setup.data.cafe.setupFinishedAt === undefined ? null : (
        <SetupChecklist setup={setup.data} devices={devices} retryDevices={retryDevices} />
      )}
      <NeedsYou devices={devices} />
      <div className="home-columns">
        <FirstMonth />
        <VisitHours />
      </div>
    </section>
  );
}

function AccountPage({ session, onSignedOut }: { session: OwnerSession; onSignedOut: (notice: string) => void }) {
  const t = useT(AR);
  return (
    <>
      <h2 id="account-page-title">{t("Account")}</h2>
      <p className="page-intro">{t("Signed in as {email}", { email: session.owner.email })}</p>
      <ChangePasswordForm
        onChanged={() => {
          onSignedOut("Your password is changed. Sign in with the new password.");
        }}
      />
    </>
  );
}

function OwnerNav({ path: shownPath }: { path: OwnerPath | null }) {
  const t = useT(AR);
  // A sub-page is shown as its page's (the signup QR's sheet as the Café page's), so a link is always current.
  const path = shownPath === "/cafe/print-qr" ? "/cafe" : shownPath;
  const { review, inbox } = useContext(AttentionContext);
  const [open, setOpen] = useState(false);
  const moreId = useId();
  const counts: Partial<Record<OwnerPath, ReactNode>> = {
    "/review":
review.status === "loaded" && review.data.items.length > 0 ? <ReviewCount queue={review.data} /> : null,
    "/inbox": inbox.status === "loaded" && inbox.data.unread > 0 ? <Count count={inbox.data.unread} label={t("{count} unread", { count: inbox.data.unread })} /> : null,
  };
  const link = (page: { path: OwnerPath; label: (typeof OWNER_PAGES)[number]["label"] }) => (
    <li key={page.path}>
      <a href={page.path} aria-current={page.path === shownPath ? "page" : page.path === path ? "true" : undefined}>
        <span>{t(page.label)}</span>
        {counts[page.path]}
      </a>
    </li>
  );
  return (
    <nav aria-label={t("Dashboard")} className="sidenav">
      <div className="sidenav-inner">
        <ul className="nav-daily">{DAILY_PAGES.map(link)}</ul>
        {/* Phones only: the setup pages open below the row. Marked when the page shown is one of them. */}
        <button
          type="button"
          className={MORE_PAGES.some((page) => page.path === path) ? "nav-more is-current" : "nav-more"}
          aria-expanded={open}
          aria-controls={moreId}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {t("More")}
        </button>
        <ul id={moreId} className={open ? "nav-setup is-open" : "nav-setup"}>
          {MORE_PAGES.map(link)}
        </ul>
      </div>
    </nav>
  );
}

/**
 * The product's mark and name: the page's one h1. The window's title is the page's own heading (its first h2, as
 * screen readers announce it) before the product's name, kept in step as the page loads, changes and switches
 * language, so tabs and history tell the pages apart (WCAG 2.4.2).
 */
function Brand({ app = "Dashboard" }: { app?: "Dashboard" | "Admin" | undefined }) {
  const t = useT(AR);
  const appName = t(app);
  useEffect(() => {
    const product = `${PRODUCT_NAME} ${appName}`;
    const main = document.querySelector("main");
    const update = () => {
      const heading = main?.querySelector("h2")?.textContent.trim() ?? "";
      const title = heading === "" ? product : `${heading} · ${product}`;
      if (document.title !== title) {
        document.title = title;
      }
    };
    update();
    if (main === null) {
      return;
    }
    const observer = new MutationObserver(update);
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
    };
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

/** A way past the top bar and the navigation, first in Tab order; the main it leads to takes focus without being a stop. */
function SkipLink() {
  const t = useT(AR);
  return (
    <a className="skip-link" href="#main">
      {t("Skip to content")}
    </a>
  );
}

/** Says the connection is gone, while it is: an alert, so it is announced when it appears. */
function OfflineNotice() {
  const t = useT(AR);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  return online ? null : (
    <p role="alert" className="warning-box offline-notice">
      {t("You are offline. Pages cannot load and changes cannot be saved until the connection is back.")}
    </p>
  );
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** An address that is no page of the dashboard: says so, with the way back. */
function NotFoundPage() {
  const t = useT(AR);
  return (
    <section aria-labelledby="not-found-title">
      <h2 id="not-found-title">{t("Page not found")}</h2>
      <p>{t("There is no page at this address. Check it, or go to Home.")}</p>
      <p>
        <a href="/">{t("Go to Home")}</a>
      </p>
    </section>
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
function OwnerLayout({ session, path, onSignedOut, children }: { session: OwnerSession; path: OwnerPath | null; onSignedOut: (notice: string) => void; children: ReactNode }) {
  const [attentionKey, setAttentionKey] = useState(0);
  const [review] = useApiData("/api/review-queue", reviewQueueSchema, attentionKey);
  const [inbox] = useApiData("/api/feedback", feedbackInboxSchema, attentionKey);
  const reload = useCallback(() => {
    setAttentionKey((key) => key + 1);
  }, []);
  return (
    <AttentionContext.Provider value={{ review, inbox, reload }}>
    <div className="owner-layout">
      <SkipLink />
      <header className="topbar">
        <Brand />
        <div className="topbar-end">
          <p className="topbar-account">
            <span className="topbar-cafe">{session.cafe.name}</span>
          </p>
          <ProfileMenu
            email={session.owner.email}
            link={{ href: "/account", label: "Account", current: path === "/account" }}
            logoutPath="/api/auth/logout"
            onSignedOut={onSignedOut}
          />
          <LanguageSwitch />
        </div>
      </header>
      <OwnerNav path={path} />
      <main id="main" tabIndex={-1} className="owner-main">
        <OfflineNotice />
        {children}
      </main>
      <BuildFooter />
    </div>
    </AttentionContext.Provider>
  );
}

/** The operator's screen: the top bar with their profile menu and the language, then the page, without the owner's navigation. */
function AdminLayout({ session, path, onSignedOut, children }: { session: OperatorSession; path: string; onSignedOut: (notice: string) => void; children: ReactNode }) {
  return (
    <div className="owner-layout admin-layout">
      <SkipLink />
      <header className="topbar">
        <Brand app="Admin" />
        <div className="topbar-end">
          <ProfileMenu
            email={session.operator.email}
            link={{ href: "/admin/password", label: "Change password", current: path === "/admin/password" }}
            logoutPath="/api/admin/logout"
            onSignedOut={onSignedOut}
          />
          <LanguageSwitch />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="admin-main page page-medium">
        <OfflineNotice />
        {children}
      </main>
      <BuildFooter />
    </div>
  );
}

/** The owner's pages: checks the session once, shows sign-in when there is none, and the page with its nav when there is. */
/** `path` is null for an address that is no page: signed in, it says so (NotFoundPage). */
function OwnerArea({ path }: { path: OwnerPath | null }) {
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
        case null:
          content = <NotFoundPage />;
          break;
        case "/":
          content = <HomePage session={state.session} />;
          break;
        case "/cafe":
          content = <CafePage />;
          break;
        case "/cafe/print-qr":
          content = <PrintQrPage cafeName={state.session.cafe.name} />;
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
          content = <AccountPage session={state.session} onSignedOut={signOut} />;
          break;
      }
      return (
        <SessionEndedContext.Provider value={signOut}>
          <OwnerLayout session={state.session} path={path} onSignedOut={signOut}>
            {content}
          </OwnerLayout>
        </SessionEndedContext.Provider>
      );
  }
}

function Page({ path }: { path: string }) {
  if (path === "/admin" || path.startsWith("/admin/")) {
    return (
      <AdminArea
        path={path}
        layout={(children, session, onSignedOut) =>
          session === null ? (
            <AuthLayout app="Admin">{children}</AuthLayout>
          ) : (
            <AdminLayout session={session} path={path} onSignedOut={onSignedOut}>
              {children}
            </AdminLayout>
          )
        }
      />
    );
  }
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
    default:
      return <OwnerArea path={isOwnerPath(path) ? path : null} />;
  }
}

export function App() {
  return (
    <LangProvider>
      <Page path={window.location.pathname} />
    </LangProvider>
  );
}
