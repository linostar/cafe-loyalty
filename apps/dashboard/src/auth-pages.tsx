import { OWNER_PASSWORD_MIN_LENGTH, ownerSessionSchema, type OwnerSession } from "@cafe-loyalty/shared";
import { useState } from "react";
import { apiRequest, messageSchema, noContent } from "./api.js";
import { Field, FormError, Notice, useLinkToken, useSubmit } from "./forms.js";

const PASSWORD_HINT = `At least ${String(OWNER_PASSWORD_MIN_LENGTH)} characters.`;

export function LoginForm({ notice, onSignedIn }: { notice: string | null; onSignedIn: (session: OwnerSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();

  return (
    <section aria-labelledby="login-title">
      <h2 id="login-title">Sign in</h2>
      {notice === null ? null : <Notice>{notice}</Notice>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(() => apiRequest("POST", "/api/auth/login", ownerSessionSchema, { email, password })).then((result) => {
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
      <p>
        <a href="/forgot-password">Forgot your password?</a>
      </p>
    </section>
  );
}

export function SignupPage() {
  const inviteToken = useLinkToken("invite");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();

  return (
    <section aria-labelledby="signup-title">
      <h2 id="signup-title">Create your owner account</h2>
      {inviteToken === null ? (
        <p role="alert" className="form-error">
          This invite link is incomplete. Open it again from the message you received, or ask for a new invite.
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(() => apiRequest("POST", "/api/auth/signup", ownerSessionSchema, { inviteToken, email, password })).then((result) => {
              if (result.ok) {
                window.location.assign("/");
              }
            });
          }}
        >
          <FormError message={error} />
          <Field label="Email" name="email" type="email" autoComplete="email" value={email} onChange={setEmail} error={fieldErrors.email} />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            hint={PASSWORD_HINT}
            minLength={OWNER_PASSWORD_MIN_LENGTH}
            error={fieldErrors.password}
          />
          <button type="submit" disabled={pending}>
            {pending ? "Creating your account…" : "Create account"}
          </button>
        </form>
      )}
    </section>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const { pending, error, fieldErrors, submit } = useSubmit();

  return (
    <section aria-labelledby="forgot-title">
      <h2 id="forgot-title">Reset your password</h2>
      {sent === null ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(() => apiRequest("POST", "/api/auth/password-reset", messageSchema, { email })).then((result) => {
              if (result.ok) {
                setSent(result.value.message);
              }
            });
          }}
        >
          <p>Enter the email you sign in with. We will send it a link to choose a new password.</p>
          <FormError message={error} />
          <Field label="Email" name="email" type="email" autoComplete="email" value={email} onChange={setEmail} error={fieldErrors.email} />
          <button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send reset link"}
          </button>
        </form>
      ) : (
        <Notice>{sent}</Notice>
      )}
      <p>
        <a href="/">Back to sign in</a>
      </p>
    </section>
  );
}

export function ResetPasswordPage() {
  const token = useLinkToken("token");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const { pending, error, fieldErrors, submit } = useSubmit();

  let content;
  if (token === null) {
    content = (
      <p role="alert" className="form-error">
        This reset link is incomplete. Open it again from the email, or <a href="/forgot-password">request a new link</a>.
      </p>
    );
  } else if (done) {
    content = <Notice>Your password is changed. Sign in with the new password.</Notice>;
  } else {
    content = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(() => apiRequest("POST", "/api/auth/password-reset/complete", noContent, { token, password })).then((result) => {
            if (result.ok) {
              setDone(true);
            }
          });
        }}
      >
        <FormError message={error} />
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          hint={PASSWORD_HINT}
          minLength={OWNER_PASSWORD_MIN_LENGTH}
          error={fieldErrors.password}
        />
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save new password"}
        </button>
      </form>
    );
  }

  return (
    <section aria-labelledby="reset-title">
      <h2 id="reset-title">Choose a new password</h2>
      {content}
      <p>
        <a href="/">Back to sign in</a>
      </p>
    </section>
  );
}
