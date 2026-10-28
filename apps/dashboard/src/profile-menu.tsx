import { useEffect, useId, useRef, useState } from "react";
import { apiRequest, noContent } from "./api.js";
import { FormError, useSubmit } from "./forms.js";
import { useT } from "./i18n.js";

const AR = {
  "Profile: ": "الملف الشخصي: ",
  Account: "الحساب",
  "Change password": "تغيير كلمة المرور",
  "Sign out": "تسجيل الخروج",
  "Signing out…": "جارٍ تسجيل الخروج…",
  "Signing out ends your session on every device.": "تسجيل الخروج ينهي جلستك على كل الأجهزة.",
} as const;

export interface ProfileLink {
  href: string;
  label: "Account" | "Change password";
  current: boolean;
}

/**
 * The top bar's profile menu, for owners and the operator: the email as a disclosure button opening a panel with the
 * email, the account link and signing out (every session of theirs, as before). Escape and a click outside close it.
 */
export function ProfileMenu({ email, link, logoutPath, onSignedOut }: { email: string; link: ProfileLink; logoutPath: string; onSignedOut: (notice: string) => void }) {
  const t = useT(AR);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { pending, error, submit } = useSubmit();

  // Open while signing out, so the outcome (or its error) is seen; otherwise closed by Escape, a click outside, or focus
  // moving out (on a phone the panel covers the nav, so focus there would be hidden under it).
  useEffect(() => {
    if (!open || pending) {
      return undefined;
    }
    const isOutside = (target: EventTarget | null) => target instanceof Node && !root.current?.contains(target);
    const outside = (event: Event) => {
      if (isOutside(event.target)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, pending]);

  return (
    <div ref={root} className="profile-menu">
      <button
        ref={button}
        type="button"
        className="profile-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className="visually-hidden">
          {t("Profile: ")}
          <bdi>{email}</bdi>
        </span>
        {/* Seen only: the email from 40rem, its first letter on phones, where the top bar has no room for it. */}
        <span className="profile-initial" aria-hidden="true">
          {email.slice(0, 1).toUpperCase()}
        </span>
        <bdi className="profile-address" aria-hidden="true">
          {email}
        </bdi>
      </button>
      <div id={panelId} className="profile-panel" hidden={!open}>
        <p className="profile-email">
          <bdi>{email}</bdi>
        </p>
        <ul>
          <li>
            <a href={link.href} aria-current={link.current ? "page" : undefined}>
              {t(link.label)}
            </a>
          </li>
          <li>
            <button
              type="button"
              aria-disabled={pending || undefined}
              aria-describedby={`${panelId}-sign-out`}
              onClick={() => {
                void submit(() => apiRequest("POST", logoutPath, noContent)).then((result) => {
                  if (result.ok) {
                    setOpen(false);
                    onSignedOut("You signed out on every device.");
                  }
                });
              }}
            >
              {pending ? t("Signing out…") : t("Sign out")}
            </button>
            <p id={`${panelId}-sign-out`} className="hint">
              {t("Signing out ends your session on every device.")}
            </p>
          </li>
        </ul>
        <FormError message={error} />
      </div>
    </div>
  );
}
