import { useEffect, useState } from "react";

/** How often a running counter asks whether a new build is out. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export interface UpdateState {
  /** A new build is installed and waits until the counter is idle. */
  waiting: boolean;
  /** Why offline use is unavailable, when the service worker could not be registered. */
  error: string | null;
}

/**
 * Registers the service worker that keeps the app usable offline, and switches to a new build only while
 * `canApply` is true: the queue is empty and nobody is in the middle of something (AC 29). The new worker waits
 * (it never skips waiting on its own); once it is told to, the page reloads into the new build.
 */
export function useServiceWorkerUpdate(canApply: boolean, enabled: boolean = import.meta.env.PROD): UpdateState {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = "serviceWorker" in navigator;

  useEffect(() => {
    if (!enabled || !supported) {
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    navigator.serviceWorker.register("/sw.js").then(
      (registered) => {
        if (!current) {
          return;
        }
        const track = () => {
          setWaiting(registered.waiting !== null);
        };
        track();
        registered.addEventListener("updatefound", () => {
          registered.installing?.addEventListener("statechange", track);
        });
        setRegistration(registered);
        timer = setInterval(() => {
          registered.update().catch((caught: unknown) => {
            console.warn("Checking for a counter update failed", caught);
          });
        }, UPDATE_CHECK_MS);
      },
      (caught: unknown) => {
        console.error("Registering the service worker failed", caught);
        if (current) {
          setError("The app could not be saved for offline use. Reload the page while online.");
        }
      },
    );
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [enabled, supported]);

  useEffect(() => {
    const next = registration?.waiting;
    if (!waiting || !canApply || next == null) {
      return;
    }
    let reloading = false;
    const reload = () => {
      if (!reloading) {
        reloading = true;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", reload);
    next.postMessage({ type: "SKIP_WAITING" });
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", reload);
    };
  }, [waiting, canApply, registration]);

  if (enabled && !supported) {
    return { waiting: false, error: "This browser cannot keep the app for offline use. Use an up-to-date Chrome or Safari." };
  }
  return { waiting, error };
}
