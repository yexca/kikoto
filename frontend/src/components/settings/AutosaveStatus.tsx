import { Check, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** How long "Saved" stays beside a section after its last save. */
const SAVED_VISIBLE_MILLISECONDS = 2500;

export type AutosaveState = "idle" | "saving" | "saved";

/**
 * The save state of a settings section whose fields save as soon as they
 * change. `track` takes a save that resolves to whether it succeeded; a failed
 * save reports its own error and leaves the section idle.
 */
export function useAutosaveStatus() {
  const [state, setState] = useState<AutosaveState>("idle");
  const pending = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A null save means nothing changed, so the section shows nothing.
  const track = useCallback(async (save: Promise<boolean> | null) => {
    if (!save) return false;
    pending.current += 1;
    window.clearTimeout(timer.current);
    setState("saving");
    const succeeded = await save.catch(() => false);
    pending.current -= 1;
    if (pending.current > 0) return succeeded;
    if (!succeeded) {
      setState("idle");
      return succeeded;
    }
    setState("saved");
    timer.current = window.setTimeout(() => setState("idle"), SAVED_VISIBLE_MILLISECONDS);
    return succeeded;
  }, []);

  return { state, track };
}

export type AutosaveTracker = ReturnType<typeof useAutosaveStatus>;

/** A section's autosave state, announced politely and shown beside its heading. */
export function AutosaveStatus({ state }: { state: AutosaveState }) {
  const { t } = useTranslation();
  return (
    <span role="status" className="inline-flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground">
      {state === "saving" && (
        <>
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {t("settings.autosave.saving")}
        </>
      )}
      {state === "saved" && (
        <>
          <Check className="h-3.5 w-3.5 text-success-foreground" aria-hidden="true" />
          {t("settings.autosave.saved")}
        </>
      )}
    </span>
  );
}
