import { useEffect, useState } from "react";

/** How often a running counter asks whether a new build is out. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export interface UpdateState {
  /** A new build is installed and waits until the counter is idle. */
  waiting: boolean;
  /** Why offline use is unavailable, when the service worker could not be registered or installed. */
  error: string | null;
}

const OFFLINE_FAILED = "The app could not be saved for offline use. Reload the page while online.";

/**
 * Registers the service worker that keeps the app usable offline, and switches to a new build only while
 * `canApply` is true: the queue is empty and nobody is in the middle of something (AC 29). The new worker waits
 * (it never skips waiting on its own); once told to, it takes over, and the page reloads into the new build as soon
 * as it is idle again.
 */
export function useServiceWorkerUpdate(canApply: boolean, enabled: boolean = import.meta.env.PROD): UpdateState {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [waiting, setWaiting] = useState(false);
  /** A new build took over this page, which still runs the old one until it reloads. */
  const [replaced, setReplaced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = "serviceWorker" in navigator;

  useEffect(() => {
    if (!enabled || !supported) {
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    // The first install also takes control (clients.claim), which is not a new build for this page.
    const hadController = navigator.serviceWorker.controller !== null;
    const onControllerChange = () => {
      if (hadController) {
        setReplaced(true);
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.register("/sw.js").then(
      (registered) => {
        if (!current) {
          return;
        }
        const track = () => {
          if (current) {
            setWaiting(registered.waiting !== null);
          }
        };
        /** Follows a worker through its states: waiting, gone (another tab let it take over), or failed to install. */
        const watch = (worker: ServiceWorker | null) => {
          worker?.addEventListener("statechange", () => {
            track();
            if (worker.state === "redundant" && navigator.serviceWorker.controller === null && current) {
              console.error("The service worker failed to install");
              setError(OFFLINE_FAILED);
            }
          });
        };
        // A worker may already be installing or waiting by the time registration resolves.
        watch(registered.installing);
        watch(registered.waiting);
        registered.addEventListener("updatefound", () => {
          watch(registered.installing);
        });
        track();
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
          setError(OFFLINE_FAILED);
        }
      },
    );
    return () => {
      current = false;
      clearInterval(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, [enabled, supported]);

  useEffect(() => {
    const next = registration?.waiting;
    if (waiting && canApply && next != null) {
      next.postMessage({ type: "SKIP_WAITING" });
    }
  }, [waiting, canApply, registration]);

  // Reloads into the new build, but only while idle: never under a barista's fingers.
  useEffect(() => {
    if (replaced && canApply) {
      window.location.reload();
    }
  }, [replaced, canApply]);

  if (enabled && !supported) {
    return { waiting: false, error: "This browser cannot keep the app for offline use. Use an up-to-date Chrome or Safari." };
  }
  return { waiting, error };
}
