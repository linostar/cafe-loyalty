import { useSyncExternalStore } from "react";
import { useT } from "./i18n.js";

const AR = {
  "Install the counter on this phone, to open it from the home screen next time.": "ثبّت الكاونتر على هذا الهاتف لتفتحه من الشاشة الرئيسية في المرة القادمة.",
  "Install the counter": "ثبّت الكاونتر",
  "To open the counter from the home screen next time: in Safari, tap Share, then Add to Home Screen.":
    "لتفتح الكاونتر من الشاشة الرئيسية في المرة القادمة: في Safari، اضغط على مشاركة، ثم إضافة إلى الشاشة الرئيسية.",
  "To find the counter next time, add it to the home screen from the browser's menu, or bookmark {address}.":
    "لتجد الكاونتر في المرة القادمة، أضفه إلى الشاشة الرئيسية من قائمة المتصفح، أو احفظ {address} في المفضلة.",
} as const;

/** The browser's offer to install the app (Chrome, Edge, Samsung Internet): not in TypeScript's DOM types. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/**
 * The install offer, kept from when the browser makes it (once, possibly before the counter shows anything), and
 * whether the counter was installed meanwhile. Read through useSyncExternalStore.
 */
let offer: BeforeInstallPromptEvent | null = null;
let installed = false;
/** Bumped on every change, as useSyncExternalStore's snapshot. */
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
};
window.addEventListener("beforeinstallprompt", (event) => {
  // Held for the counter's own button, instead of the browser's banner.
  event.preventDefault();
  offer = event as BeforeInstallPromptEvent;
  changed();
});
window.addEventListener("appinstalled", () => {
  offer = null;
  installed = true;
  changed();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => version;

/** Opened from the home screen (as an app), not in a browser tab. */
const standalone = (): boolean =>
  (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone and iPad (an iPad's Safari says Macintosh, with touch), whose Safari has no install offer, only Share. */
const appleMobile = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

/**
 * How to find the counter again once paired (the dashboard's pairing QR opened it once): while it runs in a browser tab,
 * an Install button where the browser offers one, Safari's Share steps on an iPhone or iPad, and otherwise the home
 * screen or a bookmark of its address. Nothing once it is opened from the home screen.
 */
export function InstallHint() {
  const t = useT(AR);
  // Re-renders on every change of `offer` and `installed`.
  useSyncExternalStore(subscribe, getSnapshot);
  if (installed || standalone()) {
    return null;
  }
  const held = offer;
  if (held !== null) {
    return (
      // The button under the notice, on the page's own surface (the info notice is no surface for controls).
      <div className="install-hint">
        <p className="notice notice-info">{t("Install the counter on this phone, to open it from the home screen next time.")}</p>
        <button
          type="button"
          onClick={() => {
            // An offer can be shown once.
            offer = null;
            changed();
            void held.prompt();
          }}
        >
          {t("Install the counter")}
        </button>
      </div>
    );
  }
  return (
    <p className="notice notice-info install-hint">
      {appleMobile()
        ? t("To open the counter from the home screen next time: in Safari, tap Share, then Add to Home Screen.")
        : t("To find the counter next time, add it to the home screen from the browser's menu, or bookmark {address}.", { address: window.location.host })}
    </p>
  );
}
