import { useEffect, useRef, useState } from "react";

/** While a Form's submit handler runs: what a save it starts calls, to be told when that save succeeds. */
let submitting: (() => (cleared: boolean) => void) | null = null;

/**
 * For useSubmit, as a request starts: returns what to call once it succeeded, which clears the unsaved changes of the
 * Form whose submit handler started it (nothing for a request started anywhere else). `cleared`: the form is emptied
 * after its save, so an edit made while it was on its way is gone too.
 */
export function saveStarted(): (cleared: boolean) => void {
  return submitting?.() ?? (() => undefined);
}

/**
 * A Form's unsaved changes: once something is typed or picked in it, leaving the page (every dashboard link is a full
 * page load) asks first, until a save started from its submit succeeds with nothing edited meanwhile (or empties the
 * form), or it is reset.
 * Input events count as edits; a control that changes the form without one (a button that picks days) calls `edited`.
 * ponytail: a form filled in by code (a campaign started again) does not count as edited.
 */
export interface UnsavedChanges {
  /** Something is typed or picked that is not saved. */
  dirty: boolean;
  edited: () => void;
  reset: () => void;
  submit: (handler: () => void) => void;
}

export function useUnsavedChanges(): UnsavedChanges {
  // The listener is there only while there is something to lose (one can keep a page out of the back-forward cache), and
  // reads the ref, set at once: a page that leaves right after a save (signup) must not ask before React re-renders.
  const [dirty, setDirtyState] = useState(false);
  const current = useRef(false);
  const setDirty = (value: boolean) => {
    current.current = value;
    setDirtyState(value);
  };
  const edits = useRef(0);
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      if (current.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);
  return {
    dirty,
    edited: () => {
      edits.current += 1;
      setDirty(true);
    },
    reset: () => {
      edits.current += 1;
      setDirty(false);
    },
    submit: (handler) => {
      submitting = () => {
        const editsAtStart = edits.current;
        return (cleared) => {
          if (cleared || edits.current === editsAtStart) {
            setDirty(false);
          }
        };
      };
      try {
        handler();
      } finally {
        submitting = null;
      }
    },
  };
}
