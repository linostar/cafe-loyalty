/** When this page was loaded (ms): a barista signed in before a reload is counted as active from then, at the latest. */
export const PAGE_LOADED_AT = Date.now();

/** The last tap, click or key press on the page (ms), or 0 when there has been none since it loaded. */
let last = 0;

if (typeof window !== "undefined") {
  const seen = () => {
    last = Date.now();
  };
  // Capturing, so a control that stops the event still counts as use.
  window.addEventListener("pointerdown", seen, { capture: true, passive: true });
  window.addEventListener("keydown", seen, { capture: true, passive: true });
}

/** The last time someone used the counter (ms), 0 if nobody has since the page loaded. */
export const lastActivity = (): number => last;
