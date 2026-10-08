import { linkTokenSchema } from "@cafe-loyalty/shared";
import { useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { ApiRequestError } from "./api.js";
import { SessionEndedContext } from "./session.js";

interface FieldProps {
  label: string;
  name: string;
  type: "email" | "password" | "text";
  autoComplete?: "email" | "username" | "current-password" | "new-password" | "off";
  value: string;
  onChange: (value: string) => void;
  /** Help shown under the field, such as a length rule. */
  hint?: string;
  error?: string | undefined;
  minLength?: number;
  maxLength?: number;
  /** The on-screen keyboard to show: digits for PINs and counts, decimals for prices. */
  inputMode?: "numeric" | "decimal";
  /** For Arabic text: lang "ar" and right-to-left. */
  lang?: "ar";
}

/** A labelled input whose hint and error are announced with it. */
export function Field({ label, name, type, autoComplete, value, onChange, hint, error, minLength, maxLength, inputMode, lang }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId].filter((part) => part !== null).join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required
        minLength={minLength}
        maxLength={maxLength}
        inputMode={inputMode}
        lang={lang}
        dir={lang === "ar" ? "rtl" : undefined}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === "" ? undefined : describedBy}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export interface SubmitState {
  pending: boolean;
  /** The message to show for the last failure, if any. */
  error: string | null;
  /** Per-field messages from the last failure, by field name. */
  fieldErrors: Readonly<Record<string, string>>;
  /** Runs `action`, tracking pending and errors. */
  submit: <T>(action: () => Promise<T>) => Promise<SubmitResult<T>>;
}

export type SubmitResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function useSubmit(): SubmitState {
  const onSessionEnded = useContext(SessionEndedContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit<T>(action: () => Promise<T>): Promise<SubmitResult<T>> {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      return { ok: true, value: await action() };
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.failure.code === "UNAUTHENTICATED" && onSessionEnded !== null) {
        onSessionEnded(caught.message);
      } else if (caught instanceof ApiRequestError) {
        setError(caught.message);
        setFieldErrors(Object.fromEntries(caught.details.map((detail) => [detail.path, detail.issue])));
      } else {
        setError("Something went wrong on this page. Reload it and try again.");
      }
      return { ok: false, error: caught };
    } finally {
      setPending(false);
    }
  }

  return { pending, error, fieldErrors, submit };
}

/** The form's failure message, announced when it appears. */
export function FormError({ message }: { message: string | null }) {
  return message === null ? null : (
    <p role="alert" className="form-error">
      {message}
    </p>
  );
}

/** A confirmation, announced politely when it appears. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="notice">
      {children}
    </p>
  );
}

/**
 * The invite or reset token from the page's URL fragment (`#name=token`, never sent to a server), or null when it
 * is missing or cut short (for example by a mail client wrapping the link).
 */
function fragmentToken(name: string): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get(name);
  return linkTokenSchema.safeParse(value).success ? value : null;
}

/** The link's token, read once and then removed from the address bar so it does not stay in the browser history. */
export function useLinkToken(name: string): string | null {
  const [token] = useState(() => fragmentToken(name));
  useEffect(() => {
    if (window.location.hash !== "") {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  return token;
}

/**
 * A button that asks again before a change that cannot be undone from here (revoking a device or a barista).
 * The second step is in the page, not a browser dialog, so it works with a keyboard and screen readers.
 */
export function ConfirmButton({ label, confirmLabel, pending, onConfirm }: { label: string; confirmLabel: string; pending: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  const container = useFocusOnChange<HTMLSpanElement>(asking);
  return (
    <span ref={container} className="confirm">
      {asking ? (
        <>
          <button
            type="button"
            className="danger"
            disabled={pending}
            onClick={() => {
              setAsking(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setAsking(false);
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setAsking(true);
          }}
        >
          {label}
        </button>
      )}
    </span>
  );
}

/**
 * Keeps keyboard focus where the user is when a control swaps its own view (Edit opens a form, Remove asks to
 * confirm, Done closes a panel): after `trigger` changes, focuses the first `[data-focus-target]`, input or button
 * inside the returned ref's element. Nothing moves on the first render.
 */
export function useFocusOnChange<T extends HTMLElement>(trigger: unknown): RefObject<T | null> {
  const container = useRef<T>(null);
  const previous = useRef(trigger);
  useEffect(() => {
    if (Object.is(previous.current, trigger)) {
      return;
    }
    previous.current = trigger;
    container.current?.querySelector<HTMLElement>("[data-focus-target], input, button")?.focus();
  }, [trigger]);
  return container;
}
