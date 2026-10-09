import {
  OWNER_PASSWORD_MIN_LENGTH,
  VISIT_HOURS_WEEKS,
  ownerSessionSchema,
  visitHoursSchema,
  walletDeliveriesSchema,
  type OwnerSession,
  type VisitHours as VisitHoursData,
} from "@cafe-loyalty/shared";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiRequestError, apiRequest, noContent } from "./api.js";
import { ForgotPasswordPage, LoginForm, ResetPasswordPage, SignupPage } from "./auth-pages.js";
import { CafePage } from "./cafe-page.js";
import { CampaignsPage } from "./campaigns-page.js";
import { DevicesPage } from "./devices-page.js";
import { Field, FormError, useSubmit } from "./forms.js";
import { ReviewPage } from "./review-page.js";
import { PageStatus, SessionEndedContext, useApiData } from "./session.js";
import { StaffPage } from "./staff-page.js";

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
  { path: "/account", label: "Account" },
] as const;

type OwnerPath = (typeof OWNER_PAGES)[number]["path"];

const isOwnerPath = (path: string): path is OwnerPath => OWNER_PAGES.some((page) => page.path === path);

function ChangePasswordForm({ onChanged }: { onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();

  return (
    <section aria-labelledby="password-title">
      <h3 id="password-title">Change password</h3>
      <p>Changing your password signs you out everywhere, on this device too.</p>
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
          label="Current password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
          error={fieldErrors.currentPassword}
        />
        <Field
          label="New password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={setNewPassword}
          hint={`At least ${String(OWNER_PASSWORD_MIN_LENGTH)} characters.`}
          minLength={OWNER_PASSWORD_MIN_LENGTH}
          error={fieldErrors.newPassword}
        />
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Change password"}
        </button>
      </form>
    </section>
  );
}

const WALLET_NAMES = { apple: "Apple Wallet", google: "Google Wallet" } as const;
const failureTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

/**
 * Warns when customers' wallet cards keep failing to update (AC 13); shows nothing while all goes through. The worker
 * retries undelivered passes every 15 minutes, so the notice clears itself once updates succeed again.
 */
function WalletDeliveryNotice() {
  const [state] = useApiData("/api/cafe/wallet-deliveries", walletDeliveriesSchema);
  if (state.status === "loading") {
    return null;
  }
  if (state.status === "failed") {
    return (
      <p role="alert" className="form-error">
        Could not check wallet card updates: {state.message}
      </p>
    );
  }
  if (state.data.failing.length === 0) {
    return null;
  }
  // Part of the page rather than a live alert, so screen readers do not announce it again on every visit.
  return (
    <section aria-labelledby="wallet-updates-title" className="form-error">
      <h3 id="wallet-updates-title">Wallet card updates are failing</h3>
      <p>Some customers&apos; wallet cards are not showing their latest stamps:</p>
      <ul>
        {state.data.failing.map((entry) => (
          <li key={entry.wallet}>
            {WALLET_NAMES[entry.wallet]}: {entry.passes} {entry.passes === 1 ? "card" : "cards"}, last failure{" "}
            {failureTime.format(new Date(entry.lastFailedAt))} (code {entry.lastError})
          </li>
        ))}
      </ul>
      <p>
        Stamps are still saved, and the server keeps retrying these cards every 15 minutes: they catch up, and this notice goes away, once updates go
        through again. If it is still here after a day, contact support with the codes above.
      </p>
    </section>
  );
}

const WEEKDAYS = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
] as const;
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
  return (
    <section aria-labelledby="visit-hours-title">
      <h3 id="visit-hours-title">Busy and quiet hours</h3>
      <p>
        Members only: visits recorded with a loyalty card over the last {VISIT_HOURS_WEEKS} weeks, by the hour they happened in café time
        {data === null ? "" : ` (${data.timeZone})`}. Updated every hour.
      </p>
      {state.status === "failed" ? (
        data === null ? (
          <p role="alert" className="form-error">
            Could not load the busy and quiet hours: {state.message} This page tries again in 5 minutes.
          </p>
        ) : (
          <p className="form-error">Could not update these hours: {state.message} Showing the last ones loaded; this page tries again in 5 minutes.</p>
        )
      ) : null}
      {data === null ? (
        state.status === "loading" ? (
          <PageStatus state={state} />
        ) : null
      ) : shown.length === 0 ? (
        <p>No member visits in the last {VISIT_HOURS_WEEKS} weeks yet.</p>
      ) : (
        <div className="visit-hours">
          <table>
            <caption className="visually-hidden">Member visits by hour and weekday</caption>
            <thead>
              <tr>
                <th scope="col">Hour</th>
                {WEEKDAYS.map(([short, long]) => (
                  <th scope="col" key={short}>
                    <abbr title={long}>{short}</abbr>
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
                      <td key={WEEKDAYS[weekday]?.[0]} className={`level-${String(Math.ceil((visits / busiest) * 4))}`}>
                        {visits}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HomePage({ session }: { session: OwnerSession }) {
  return (
    <section aria-labelledby="cafe-title">
      <h2 id="cafe-title">{session.cafe.name}</h2>
      <p>Signed in as {session.owner.email}</p>
      <WalletDeliveryNotice />
      <VisitHours />
      <ul className="items">
        <li>
          <a href="/cafe">Café</a>: name, loyalty program and order types
        </li>
        <li>
          <a href="/campaigns">Campaigns</a>: discounts at quiet hours, above your minimum margin
        </li>
        <li>
          <a href="/staff">Staff</a>: baristas and their PINs
        </li>
        <li>
          <a href="/devices">Devices</a>: pair or remove counter phones
        </li>
        <li>
          <a href="/review">Review</a>: what removed phones and baristas recorded
        </li>
        <li>
          <a href="/account">Account</a>: password and signing out
        </li>
      </ul>
    </section>
  );
}

function AccountPage({ onSignedOut }: { onSignedOut: (notice: string) => void }) {
  const { pending, error, submit } = useSubmit();
  return (
    <>
      <section aria-labelledby="account-title">
        <h2 id="account-title">Account</h2>
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
          {pending ? "Signing out…" : "Sign out"}
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
  return (
    <nav aria-label="Dashboard">
      <ul>
        {OWNER_PAGES.map((page) => (
          <li key={page.path}>
            <a href={page.path} aria-current={page.path === path ? "page" : undefined}>
              {page.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The owner's pages: checks the session once, shows sign-in when there is none, and the page with its nav when there is. */
function OwnerArea({ path }: { path: OwnerPath }) {
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
          setState({ status: "unavailable", message: error instanceof Error ? error.message : "Could not check your session." });
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
      return <p role="status">Loading…</p>;
    case "unavailable":
      return (
        <>
          <p role="alert" className="form-error">
            {state.message}
          </p>
          <button
            type="button"
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </>
      );
    case "signed-out":
      return (
        <LoginForm
          notice={state.notice}
          onSignedIn={(session) => {
            setState({ status: "signed-in", session });
          }}
        />
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
        case "/account":
          content = <AccountPage onSignedOut={signOut} />;
          break;
      }
      return (
        <SessionEndedContext.Provider value={signOut}>
          <OwnerNav path={path} />
          {content}
        </SessionEndedContext.Provider>
      );
  }
}

function Page({ path }: { path: string }) {
  switch (path) {
    case "/signup":
      return <SignupPage />;
    case "/forgot-password":
      return <ForgotPasswordPage />;
    case "/reset-password":
      return <ResetPasswordPage />;
    default:
      return <OwnerArea path={isOwnerPath(path) ? path : "/"} />;
  }
}

export function App() {
  return (
    <>
      <header>
        <h1>Cafe Loyalty Dashboard</h1>
      </header>
      <main>
        <Page path={window.location.pathname} />
      </main>
      <footer>
        <p>Build {__BUILD_ID__}</p>
      </footer>
    </>
  );
}
