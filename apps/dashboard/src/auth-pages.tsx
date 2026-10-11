import { OWNER_PASSWORD_MIN_LENGTH, ownerSessionSchema, type OwnerSession } from "@cafe-loyalty/shared";
import { useState } from "react";
import { apiRequest, messageSchema, noContent } from "./api.js";
import { Field, FormError, Notice, useLinkToken, useSubmit } from "./forms.js";
import { useApiText, useT } from "./i18n.js";

const AR = {
  "Sign in": "تسجيل الدخول",
  "Signing in…": "جارٍ تسجيل الدخول…",
  Email: "البريد الإلكتروني",
  Password: "كلمة المرور",
  "New password": "كلمة المرور الجديدة",
  "At least {n} characters.": "{n} أحرف على الأقل.",
  "Forgot your password?": "نسيت كلمة المرور؟",
  "Create your owner account": "أنشئ حساب المالك",
  "This invite link is incomplete. Open it again from the message you received, or ask for a new invite.":
    "رابط الدعوة هذا ناقص. افتحه مجدداً من الرسالة التي وصلتك، أو اطلب دعوة جديدة.",
  "Creating your account…": "جارٍ إنشاء حسابك…",
  "Create account": "إنشاء الحساب",
  "Reset your password": "إعادة تعيين كلمة المرور",
  "Enter the email you sign in with. We will send it a link to choose a new password.": "أدخل البريد الذي تسجّل الدخول به. سنرسل إليه رابطاً لاختيار كلمة مرور جديدة.",
  "Sending…": "جارٍ الإرسال…",
  "Send reset link": "إرسال رابط إعادة التعيين",
  "Back to sign in": "العودة إلى تسجيل الدخول",
  "This reset link is incomplete. Open it again from the email, or": "رابط إعادة التعيين هذا ناقص. افتحه مجدداً من الرسالة، أو",
  "request a new link": "اطلب رابطاً جديداً",
  "Your password is changed. Sign in with the new password.": "تغيّرت كلمة مرورك. سجّل الدخول بكلمة المرور الجديدة.",
  "Choose a new password": "اختر كلمة مرور جديدة",
  "Save new password": "حفظ كلمة المرور الجديدة",
} as const;

export function LoginForm({ notice, onSignedIn }: { notice: string | null; onSignedIn: (session: OwnerSession) => void }) {
  const t = useT(AR);
  const api = useApiText();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();

  return (
    <section aria-labelledby="login-title">
      <h2 id="login-title">{t("Sign in")}</h2>
      {notice === null ? null : <Notice>{api(notice)}</Notice>}
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
        <Field label={t("Email")} name="email" type="email" autoComplete="username" value={email} onChange={setEmail} error={fieldErrors.email} />
        <Field label={t("Password")} name="password" type="password" autoComplete="current-password" value={password} onChange={setPassword} error={fieldErrors.password} />
        <button type="submit" disabled={pending}>
          {pending ? t("Signing in…") : t("Sign in")}
        </button>
      </form>
      <p>
        <a href="/forgot-password">{t("Forgot your password?")}</a>
      </p>
    </section>
  );
}

export function SignupPage() {
  const t = useT(AR);
  const inviteToken = useLinkToken("invite");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();

  return (
    <section aria-labelledby="signup-title">
      <h2 id="signup-title">{t("Create your owner account")}</h2>
      {inviteToken === null ? (
        <p role="alert" className="form-error">
          {t("This invite link is incomplete. Open it again from the message you received, or ask for a new invite.")}
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
          <Field label={t("Email")} name="email" type="email" autoComplete="email" value={email} onChange={setEmail} error={fieldErrors.email} />
          <Field
            label={t("Password")}
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            hint={t("At least {n} characters.", { n: OWNER_PASSWORD_MIN_LENGTH })}
            minLength={OWNER_PASSWORD_MIN_LENGTH}
            error={fieldErrors.password}
          />
          <button type="submit" disabled={pending}>
            {pending ? t("Creating your account…") : t("Create account")}
          </button>
        </form>
      )}
    </section>
  );
}

export function ForgotPasswordPage() {
  const t = useT(AR);
  const api = useApiText();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const { pending, error, fieldErrors, submit } = useSubmit();

  return (
    <section aria-labelledby="forgot-title">
      <h2 id="forgot-title">{t("Reset your password")}</h2>
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
          <p>{t("Enter the email you sign in with. We will send it a link to choose a new password.")}</p>
          <FormError message={error} />
          <Field label={t("Email")} name="email" type="email" autoComplete="email" value={email} onChange={setEmail} error={fieldErrors.email} />
          <button type="submit" disabled={pending}>
            {pending ? t("Sending…") : t("Send reset link")}
          </button>
        </form>
      ) : (
        <Notice>{api(sent)}</Notice>
      )}
      <p>
        <a href="/">{t("Back to sign in")}</a>
      </p>
    </section>
  );
}

export function ResetPasswordPage() {
  const t = useT(AR);
  const token = useLinkToken("token");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const { pending, error, fieldErrors, submit } = useSubmit();

  let content;
  if (token === null) {
    content = (
      <p role="alert" className="form-error">
        {t("This reset link is incomplete. Open it again from the email, or")} <a href="/forgot-password">{t("request a new link")}</a>.
      </p>
    );
  } else if (done) {
    content = <Notice>{t("Your password is changed. Sign in with the new password.")}</Notice>;
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
          label={t("New password")}
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          hint={t("At least {n} characters.", { n: OWNER_PASSWORD_MIN_LENGTH })}
          minLength={OWNER_PASSWORD_MIN_LENGTH}
          error={fieldErrors.password}
        />
        <button type="submit" disabled={pending}>
          {pending ? t("Saving…") : t("Save new password")}
        </button>
      </form>
    );
  }

  return (
    <section aria-labelledby="reset-title">
      <h2 id="reset-title">{t("Choose a new password")}</h2>
      {content}
      <p>
        <a href="/">{t("Back to sign in")}</a>
      </p>
    </section>
  );
}
