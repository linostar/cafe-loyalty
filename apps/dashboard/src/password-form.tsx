import { OWNER_PASSWORD_MIN_LENGTH } from "@cafe-loyalty/shared";
import { useState } from "react";
import { apiRequest, noContent } from "./api.js";
import { Field, FormError, useSubmit } from "./forms.js";
import { useT } from "./i18n.js";

const AR = {
  "Change password": "تغيير كلمة المرور",
  "Changing your password signs you out everywhere, on this device too.": "تغيير كلمة المرور يسجّل خروجك من كل مكان، ومن هذا الجهاز أيضاً.",
  "Current password": "كلمة المرور الحالية",
  "New password": "كلمة المرور الجديدة",
  "At least {n} characters.": "{n} أحرف على الأقل.",
} as const;

/** Changing the owner's (or, with `path`, the operator's) password; the server then ends every session, this one too. */
export function ChangePasswordForm({ onChanged, path = "/api/auth/password" }: { onChanged: () => void; path?: string }) {
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
          void submit(() => apiRequest("POST", path, noContent, { currentPassword, newPassword })).then((result) => {
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
