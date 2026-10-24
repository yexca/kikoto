import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";

/**
 * Whether lyrics files written by speech recognition or translation open with
 * a line naming their models. The choice applies to files written after it
 * changes.
 */
export function LyricsAttributionSection({ readOnly = false }: { readOnly?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .lyricsAttribution()
      .then((result) => setEnabled(result.enabled))
      .catch(() => setEnabled(true));
  }, []);

  const save = async (next: boolean) => {
    setSaving(true);
    try {
      setEnabled((await api.updateLyricsAttribution(next)).enabled);
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.llm.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title={t("maintenance.llm.attributionTitle")}>
      <SettingsRow title={t("maintenance.llm.attribution")} description={t("maintenance.llm.attributionDescription")}>
        <Switch
          checked={enabled ?? true}
          disabled={readOnly || saving || enabled === null}
          aria-label={t("maintenance.llm.attribution")}
          onCheckedChange={(next) => void save(next)}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
