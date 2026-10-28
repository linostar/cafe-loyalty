import { apiText, linkTokenSchema } from "@cafe-loyalty/shared";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ApiRequestError } from "./api.js";
import { useApiText, useCommonT } from "./i18n.js";
import { SessionEndedContext } from "./session.js";

interface FieldProps {
  /** Text, or text with a visually hidden part that tells repeated fields apart. */
  label: ReactNode;
  name: string;
  type: "email" | "password" | "text" | "url";
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
  /** For text in one language whatever the page's: Arabic right to left, English left to right. */
  lang?: "ar" | "en";
  /** May be left empty (fields are required otherwise). */
  optional?: boolean;
  /** Keys the field handles itself, such as Escape to step back from a second step. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/** How many times the form around a field was sent, so a field can tell a new failed attempt from the last one. */
const SubmitAttemptContext = createContext(0);

/**
 * A form that checks its own fields: the browser's validation bubbles are off (they come in the browser's language,
 * not the page's, and vanish), so every problem shows as the field's own message, and after each attempt the first
 * control with one gets focus (useFocusWhenInvalid, which every input marked `aria-invalid` in a Form uses).
 */
export function Form({ onSubmit, children, ...props }: Omit<ComponentProps<"form">, "noValidate">) {
  const [attempt, setAttempt] = useState(0);
  return (
    <form
      {...props}
      noValidate
      onSubmit={(event) => {
        setAttempt((count) => count + 1);
        onSubmit?.(event);
      }}
    >
      <SubmitAttemptContext.Provider value={attempt}>{children}</SubmitAttemptContext.Provider>
    </form>
  );
}

/**
 * For an input marked `aria-invalid` while `invalid`: when a send of its form leaves it with a problem (found before
 * sending, or in the answer) and it is the form's first control with one, it takes focus, so its message is read. Keyed
 * on whether there is a problem, not on its text, so switching language (which retranslates the text) moves nothing.
 */
export function useFocusWhenInvalid<T extends HTMLInputElement>(invalid: boolean): RefObject<T | null> {
  const input = useRef<T>(null);
  const attempt = useContext(SubmitAttemptContext);
  useEffect(() => {
    const element = input.current;
    if (!invalid || element === null || attempt === 0) {
      return;
    }
    if (element.form?.querySelector('[aria-invalid="true"]') === element) {
      element.focus();
    }
  }, [invalid, attempt]);
  return input;
}

/** A labelled input whose hint and error are announced with it, and which takes focus after a failed send (useFocusWhenInvalid). */
export function Field({ label, name, type, autoComplete, value, onChange, hint, error, minLength, maxLength, inputMode, lang, optional = false, onKeyDown }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId].filter((part) => part !== null).join(" ");
  const api = useApiText();
  const input = useFocusWhenInvalid(error !== undefined);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={input}
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={!optional}
        minLength={minLength}
        maxLength={maxLength}
        inputMode={inputMode}
        lang={lang}
        dir={lang === undefined ? undefined : lang === "ar" ? "rtl" : "ltr"}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
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
          {api(error)}
        </p>
      )}
    </div>
  );
}

export interface SubmitState {
  /**
   * A request is on its way. Buttons show it with `aria-disabled`, never `disabled`: a focused button that becomes
   * disabled drops keyboard focus to the page (WCAG 2.4.3); `submit` ignores what is sent meanwhile instead.
   */
  pending: boolean;
  /** The message to show for the last failure, if any, in English as the API sent it (FormError translates it). */
  error: string | null;
  /** Per-field messages from the last failure, by field name, in English (Field translates them). */
  fieldErrors: Readonly<Record<string, string>>;
  /** The last request succeeded, until the next one starts or `clearDone`: the form shows "Saved." next to its button. */
  done: boolean;
  clearDone: () => void;
  /** Runs `action`, tracking pending and errors; while one is pending, another is not run (a failed result, nothing shown). */
  submit: <T>(action: () => Promise<T>) => Promise<SubmitResult<T>>;
}

export type SubmitResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** The failure `submit` gives a request sent while another is pending; nothing is shown for it. */
export class StillPendingError extends Error {
  constructor() {
    super("A request is already on its way");
    this.name = "StillPendingError";
  }
}

export function useSubmit(): SubmitState {
  const onSessionEnded = useContext(SessionEndedContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  // Read and set synchronously: two clicks before a re-render would both see `pending` false.
  const inFlight = useRef(false);
  // Edits counted by `clearDone`: one made while a request was on its way means what it saved is no longer what the
  // form shows, so it does not say "Saved.".
  const edits = useRef(0);

  async function submit<T>(action: () => Promise<T>): Promise<SubmitResult<T>> {
    if (inFlight.current) {
      return { ok: false, error: new StillPendingError() };
    }
    inFlight.current = true;
    const editsAtStart = edits.current;
    setPending(true);
    setError(null);
    setFieldErrors({});
    setDone(false);
    try {
      const value = await action();
      if (edits.current === editsAtStart) {
        setDone(true);
      }
      return { ok: true, value };
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.failure.code === "UNAUTHENTICATED" && onSessionEnded !== null) {
        onSessionEnded(caught.message);
      } else if (caught instanceof ApiRequestError) {
        setError(caught.message);
        // Several issues of one field (such as each order type below a campaign's floor) are all shown: kept in English,
        // one per line, so each is translated on its own when shown (useSay).
        const byField: Record<string, string> = {};
        for (const detail of caught.details) {
          const earlier = byField[detail.path];
          byField[detail.path] = earlier === undefined ? detail.issue : `${earlier}\n${detail.issue}`;
        }
        setFieldErrors(byField);
      } else {
        setError(apiText("Something went wrong on this page. Reload it and try again."));
      }
      return { ok: false, error: caught };
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    error,
    fieldErrors,
    done,
    clearDone: () => {
      edits.current += 1;
      setDone(false);
    },
    submit,
  };
}

/** The form's failure message in the page's language, announced when it appears. */
export function FormError({ message }: { message: string | null }) {
  const api = useApiText();
  return message === null ? null : (
    <p role="alert" className="form-error">
      {api(message)}
    </p>
  );
}

/**
 * A confirmation, announced politely. Render it all the time, with no children while there is nothing to say: screen
 * readers announce text that changes in a status region already in the page, but often miss one added with its text.
 */
export function Notice({ children }: { children?: ReactNode }) {
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
 * The second step is in the page, not a browser dialog, so it works with a keyboard and screen readers. `name` and
 * `confirmName`, when given, are the buttons' accessible names: a short visible label, and a name that starts with it
 * and tells the item apart (WCAG 2.5.3).
 */
export function ConfirmButton({
  label,
  confirmLabel,
  name,
  confirmName,
  pending,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  name?: string;
  confirmName?: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useCommonT();
  const [asking, setAsking] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  /** Where focus goes once the step has rendered: Cancel while asking (the safe choice), the button after cancelling. */
  const focusNext = useRef<"cancel" | "start" | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    const selector = target === "cancel" ? "[data-confirm-cancel]" : target === "start" ? "button" : null;
    if (selector !== null) {
      container.current?.querySelector<HTMLElement>(selector)?.focus();
    }
  }, [asking]);

  const cancel = () => {
    focusNext.current = "start";
    setAsking(false);
  };
  const cancelOnEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      cancel();
    }
  };

  return (
    <span ref={container} className="confirm">
      {asking ? (
        <>
          <button
            type="button"
            className="danger"
            aria-label={confirmName}
            aria-disabled={pending || undefined}
            onKeyDown={cancelOnEscape}
            onClick={() => {
              if (pending) {
                return;
              }
              // The item may change or disappear, so focus moves to its section's heading, which stays.
              container.current?.closest("section")?.querySelector<HTMLElement>("[data-focus-after-change]")?.focus();
              setAsking(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
          <button type="button" data-confirm-cancel onKeyDown={cancelOnEscape} onClick={cancel}>
            {t("Cancel")}
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={name}
          aria-disabled={pending || undefined}
          onClick={() => {
            if (pending) {
              return;
            }
            focusNext.current = "cancel";
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
