import { apiText, type FeedbackInbox, type ReviewQueue } from "@cafe-loyalty/shared";
import { createContext, useContext, useEffect, useState } from "react";
import type { z } from "zod";
import { ApiRequestError, apiRequest } from "./api.js";
import { useApiText, useCommonT } from "./i18n.js";

/**
 * Inside the signed-in pages: returns the owner to the sign-in form with a message, for any request answered
 * UNAUTHENTICATED (the session ended on another device, by password change or by timing out). Null elsewhere.
 */
export const SessionEndedContext = createContext<((message: string) => void) | null>(null);

export type ApiData<T> = { status: "loading" } | { status: "loaded"; data: T } | { status: "failed"; message: string };

/**
 * What waits for the owner, from the lists the API already serves: visits and actions held for review (the queue's
 * first page) and unread customer messages. Loaded once per page by the signed-in layout, for the navigation's counts
 * and Home; `reload` loads both again, for a page that has just changed them (a decision on Review, a message read).
 */
export interface Attention {
  review: ApiData<ReviewQueue>;
  inbox: ApiData<FeedbackInbox>;
  reload: () => void;
}

export const AttentionContext = createContext<Attention>({ review: { status: "loading" }, inbox: { status: "loading" }, reload: () => undefined });

/**
 * Loads `path` for a page (a failure's message in English as the API sent it; PageStatus translates it), again whenever
 * `reloadKey` changes; an ended session goes back to sign-in. The setter takes new data, or a function of the latest
 * loaded data, for responses that may land while another is in flight. `retry` loads it again in place (PageStatus's
 * Try again), leaving the rest of the page, and anything typed into it, as it is.
 */
export function useApiData<T extends z.ZodType>(
  path: string,
  schema: T,
  reloadKey = 0,
): [ApiData<z.output<T>>, (data: z.output<T> | ((current: z.output<T>) => z.output<T>)) => void, () => void] {
  const onSessionEnded = useContext(SessionEndedContext);
  const [state, setState] = useState<ApiData<z.output<T>>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    apiRequest("GET", path, schema).then(
      (data) => {
        if (current) {
          setState({ status: "loaded", data });
        }
      },
      (error: unknown) => {
        if (!current) {
          return;
        }
        if (error instanceof ApiRequestError && error.failure.code === "UNAUTHENTICATED" && onSessionEnded !== null) {
          onSessionEnded(error.message);
        } else {
          setState({ status: "failed", message: error instanceof Error ? error.message : apiText("Could not load this page. Reload it and try again.") });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [path, schema, reloadKey, attempt, onSessionEnded]);

  return [
    state,
    (data) => {
      setState((current) => {
        if (!(data instanceof Function)) {
          return { status: "loaded", data };
        }
        return current.status === "loaded" ? { status: "loaded", data: data(current.data) } : current;
      });
    },
    () => {
      setState({ status: "loading" });
      setAttempt((count) => count + 1);
    },
  ];
}

/**
 * The loading and failure states every page, or a section of one, shows before its content; a failed load offers to
 * load it again with `onRetry` (useApiData's retry), never by reloading the document, which would lose what was typed
 * elsewhere on the page and, offline, leave the dashboard for the browser's error page.
 */
export function PageStatus({ state, onRetry }: { state: ApiData<unknown>; onRetry: () => void }) {
  const t = useCommonT();
  const api = useApiText();
  return state.status === "failed" ? (
    <>
      <p role="alert" className="form-error">
        {api(state.message)}
      </p>
      <button type="button" className="primary" onClick={onRetry}>
        {t("Try again")}
      </button>
    </>
  ) : (
    <p role="status">{t("Loading…")}</p>
  );
}
