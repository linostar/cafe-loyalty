import { linkTokenSchema } from "@cafe-loyalty/shared";
import { useEffect, useId, useState, type ReactNode } from "react";
import { ApiRequestError } from "./api.js";

interface FieldProps {
  label: string;
  name: string;
  type: "email" | "password";
  autoComplete: "email" | "username" | "current-password" | "new-password";
  value: string;
  onChange: (value: string) => void;
  /** Help shown under the field, such as a length rule. */
  hint?: string;
  error?: string | undefined;
  minLength?: number;
}

/** A labelled input whose hint and error are announced with it. */
export function Field({ label, name, type, autoComplete, value, onChange, hint, error, minLength }: FieldProps) {
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
      if (caught instanceof ApiRequestError) {
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
