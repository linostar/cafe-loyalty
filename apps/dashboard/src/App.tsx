import { OWNER_PASSWORD_MIN_LENGTH, ownerSessionSchema, type OwnerSession } from "@cafe-loyalty/shared";
import { useEffect, useState } from "react";
import { ApiRequestError, apiRequest, noContent } from "./api.js";
import { ForgotPasswordPage, LoginForm, ResetPasswordPage, SignupPage } from "./auth-pages.js";
import { Field, FormError, useSubmit } from "./forms.js";

type HomeState =
  | { status: "loading" }
  | { status: "signed-out"; notice: string | null }
  | { status: "signed-in"; session: OwnerSession }
  | { status: "unavailable"; message: string };

function ChangePasswordForm({ onChanged, onSessionEnded }: { onChanged: () => void; onSessionEnded: (message: string) => void }) {
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
            } else if (result.error instanceof ApiRequestError && result.error.failure.code === "UNAUTHENTICATED") {
              onSessionEnded(result.error.message);
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

function SignedInHome({ session, onSignedOut }: { session: OwnerSession; onSignedOut: (notice: string) => void }) {
  const { pending, error, submit } = useSubmit();
  return (
    <>
      <section aria-labelledby="cafe-title">
        <h2 id="cafe-title">{session.cafe.name}</h2>
        <p>Signed in as {session.owner.email}</p>
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
        onSessionEnded={onSignedOut}
      />
    </>
  );
}

/** `/`: the signed-in owner's home, or the sign-in form. */
function HomeRoute() {
  const [state, setState] = useState<HomeState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

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
      return (
        <SignedInHome
          session={state.session}
          onSignedOut={(notice) => {
            setState({ status: "signed-out", notice });
          }}
        />
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
      return <HomeRoute />;
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
