import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { AutosaveStatus, useAutosaveStatus } from "@/components/settings/AutosaveStatus";
import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { deviceTimeZone, setListeningTimeZone } from "@/lib/timeZone";

import { TimeZoneSelect } from "./TimeZoneSelect";

/** The id a Settings link scrolls to. */
export const ACCOUNT_TIME_ZONE_SECTION_ID = "settings-section-time-zone";

/**
 * The account's time zone: automatic, which follows the device in use, or one
 * IANA zone for every device. The zone decides where a day starts in the
 * account's listening report. A choice saves at once and reaches this tab's
 * player; a failed save returns to the saved zone.
 */
export function AccountTimeZoneSection({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  // The saved zone; an empty string is automatic, and null is not loaded yet.
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const autosave = useAutosaveStatus();

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    api
      .getUserPreferences(controller.signal)
      .then((preferences) => {
        const next = preferences.timeZone ?? "";
        setSaved(next);
        setDraft(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [attempt]);

  const save = async (zone: string) => {
    setDraft(zone);
    setSaving(true);
    try {
      const preferences = await api.updateUserPreferences({ timeZone: zone || null });
      const next = preferences.timeZone ?? "";
      setSaved(next);
      setDraft(next);
      setListeningTimeZone(preferences.timeZone ?? null);
      return true;
    } catch (error) {
      setDraft(saved ?? "");
      toast.notify(toastFromError(error, t("timeZone.saveFailed")));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const choose = (zone: string) => {
    if (readOnly || saving || saved === null || zone === saved) return;
    void autosave.track(save(zone));
  };

  const device = deviceTimeZone() ?? "UTC";
  return (
    <SettingsSection
      id={ACCOUNT_TIME_ZONE_SECTION_ID}
      className="scroll-mt-[calc(var(--header-height)+var(--safe-area-top)+1rem)]"
      title={t("timeZone.title")}
      action={<AutosaveStatus state={autosave.state} />}
    >
      <SettingsRow htmlFor="account-time-zone" title={t("timeZone.title")} description={t("timeZone.description")}>
        {failed ? (
          <span role="alert" className="flex items-center gap-2 text-sm text-muted-foreground">
            {t("timeZone.loadFailed")}
            <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              {t("common.retry")}
            </Button>
          </span>
        ) : (
          <TimeZoneSelect
            id="account-time-zone"
            value={draft}
            followLabel={t("timeZone.auto", { zone: device })}
            inUse={[saved, device]}
            disabled={readOnly || saving || saved === null}
            ariaLabel={t("timeZone.title")}
            onChange={choose}
          />
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
