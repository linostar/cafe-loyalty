import { createContext, useContext, useEffect, useState } from "react";
import type { z } from "zod";
import { ApiRequestError, apiRequest } from "./api.js";

/**
 * Inside the signed-in pages: returns the owner to the sign-in form with a message, for any request answered
 * UNAUTHENTICATED (the session ended on another device, by password change or by timing out). Null elsewhere.
 */
export const SessionEndedContext = createContext<((message: string) => void) | null>(null);

export type ApiData<T> = { status: "loading" } | { status: "loaded"; data: T } | { status: "failed"; message: string };

/** Loads `path` for a page, again whenever `reloadKey` changes; an ended session goes back to sign-in. */
export function useApiData<T extends z.ZodType>(path: string, schema: T, reloadKey = 0): [ApiData<z.output<T>>, (data: z.output<T>) => void] {
  const onSessionEnded = useContext(SessionEndedContext);
  const [state, setState] = useState<ApiData<z.output<T>>>({ status: "loading" });

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
          setState({ status: "failed", message: error instanceof Error ? error.message : "Could not load this page. Reload it and try again." });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [path, schema, reloadKey, onSessionEnded]);

  return [
    state,
    (data) => {
      setState({ status: "loaded", data });
    },
  ];
}

/** The loading and failure states every page shows before its content. */
export function PageStatus({ state }: { state: ApiData<unknown> }) {
  return state.status === "failed" ? (
    <p role="alert" className="form-error">
      {state.message}
    </p>
  ) : (
    <p role="status">Loading…</p>
  );
}
