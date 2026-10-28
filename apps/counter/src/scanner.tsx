import jsQR from "jsqr";
import { useEffect, useId, useRef, useState } from "react";
import { useT, type Translate } from "./i18n.js";

const AR = {
  "The camera is not allowed. {next} To scan, allow this site to use the camera in the browser's settings.":
    "الكاميرا غير مسموح بها. {next} للمسح، اسمح لهذا الموقع باستخدام الكاميرا من إعدادات المتصفح.",
  "No camera was found on this phone. {next}": "لم يُعثر على كاميرا في هذا الهاتف. {next}",
  "The camera could not start. Close other apps that use it, then try again.": "تعذّر تشغيل الكاميرا. أغلق التطبيقات الأخرى التي تستخدمها، ثم حاول مجدداً.",
  "Point the camera at the {purpose}.": "وجّه الكاميرا نحو {purpose}.",
} as const;

/** How often a camera frame is checked for a QR code. */
const SCAN_INTERVAL_MS = 200;

/**
 * The text of the QR code in an image (RGBA pixels), or null when there is none. Inverted codes (light on dark) are
 * read too: a browser's forced dark mode, or a dark wallet theme, can show the card that way.
 */
export function decodeQr(image: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  return jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

function cameraProblem(error: unknown, noCamera: string, t: Translate<typeof AR>): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    // What to do now first: the browser setting is for later, and usually needs the owner.
    return t("The camera is not allowed. {next} To scan, allow this site to use the camera in the browser's settings.", { next: noCamera });
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return t("No camera was found on this phone. {next}", { next: noCamera });
  }
  return t("The camera could not start. Close other apps that use it, then try again.");
}

/**
 * Shows the back camera and reports the first QR code it sees, reading frames on the phone (nothing leaves it). The
 * camera is released when the scanner closes. `purpose` names what to scan and `noCamera` says what to do instead on a
 * phone without one, both in the page's language.
 */
export function QrScanner({ purpose, noCamera, onScan, onCancel }: { purpose: string; noCamera: string; onScan: (text: string) => void; onCancel: () => void }) {
  const t = useT(AR);
  const video = useRef<HTMLVideoElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  /** Why the camera failed, put into words when shown, so it follows a language switch. */
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const problem = failure === null ? null : cameraProblem(failure.error, noCamera, t);

  // The keyboard lands on the way out of the scanner, which is all it can do here.
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  const reported = useRef(onScan);
  useEffect(() => {
    reported.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let active = true;
    // Read through a call: TypeScript would otherwise assume `active` cannot change across the awaits.
    const isActive = () => active;
    const canvas = document.createElement("canvas");
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(
      async (opened) => {
        if (!isActive()) {
          for (const track of opened.getTracks()) {
            track.stop();
          }
          return;
        }
        stream = opened;
        const element = video.current;
        if (element === null) {
          return;
        }
        element.srcObject = opened;
        try {
          await element.play();
        } catch (caught) {
          console.error("Starting the camera preview failed", caught);
          // The camera is no use without its preview: switch it off now, not when the scanner closes.
          for (const track of opened.getTracks()) {
            track.stop();
          }
          if (isActive()) {
            setFailure({ error: caught });
          }
          return;
        }
        timer = setInterval(() => {
          if (element.videoWidth === 0) {
            return;
          }
          canvas.width = element.videoWidth;
          canvas.height = element.videoHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (context === null) {
            return;
          }
          context.drawImage(element, 0, 0);
          const text = decodeQr(context.getImageData(0, 0, canvas.width, canvas.height));
          if (text !== null && isActive()) {
            active = false;
            clearInterval(timer);
            reported.current(text);
          }
        }, SCAN_INTERVAL_MS);
      },
      (caught: unknown) => {
        console.error("Opening the camera failed", caught);
        if (isActive()) {
          setFailure({ error: caught });
        }
      },
    );
    return () => {
      active = false;
      clearInterval(timer);
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, []);

  return (
    <div className="scanner">
      {problem === null ? (
        <p id={helpId}>{t("Point the camera at the {purpose}.", { purpose })}</p>
      ) : (
        <p id={helpId} role="alert" className="field-error">
          {problem}
        </p>
      )}
      {problem === null ? <video ref={video} className="camera" muted playsInline aria-describedby={helpId} /> : null}
      <button ref={cancel} type="button" onClick={onCancel}>
        {t("Cancel")}
      </button>
    </div>
  );
}
