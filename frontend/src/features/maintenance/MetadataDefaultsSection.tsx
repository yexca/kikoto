import { Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsNumberInput, SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type AppSettings } from "@/lib/api";

import {
  dlsiteMetadataLanguageOptions,
  dlsiteMetadataLanguagesFor,
  preferredDlsiteMetadataLanguage,
  type DlsiteMetadataLanguage,
} from "./metadataLanguageModel";

/**
 * Instance-wide metadata defaults in Settings → Metadata: the default metadata
 * language and how long creator catalogs stay fresh. Save sends only the
 * changed values, so it never overwrites settings edited elsewhere.
 */
export function MetadataDefaultsSection({
  settings,
  readOnly,
  onSaved,
}: {
  settings: AppSettings;
  readOnly: boolean;
  onSaved: (settings: AppSettings) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const savedLanguage = preferredDlsiteMetadataLanguage(settings.dlsiteMetadataLanguages);
  const [language, setLanguage] = useState<DlsiteMetadataLanguage>(savedLanguage);
  const [days, setDays] = useState(settings.catalogFreshnessDays);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLanguage(savedLanguage);
    setDays(settings.catalogFreshnessDays);
  }, [savedLanguage, settings.catalogFreshnessDays]);

  const languageChanged = language !== savedLanguage;
  const daysChanged = days !== settings.catalogFreshnessDays;
  const daysValid = Number.isInteger(days) && days >= 1 && days <= 365;

  const save = async () => {
    if (readOnly || saving || !daysValid) return;
    setSaving(true);
    try {
      onSaved(
        await api.updateSettings({
          ...(daysChanged ? { catalogFreshnessDays: days } : {}),
          ...(languageChanged ? { dlsiteMetadataLanguages: dlsiteMetadataLanguagesFor(language) } : {}),
        }),
      );
      toast.success(t("maintenance.settingsSaved"));
    } catch (cause) {
      toast.notify(toastFromError(cause, t("maintenance.settingsApiUnavailable")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={t("maintenance.metadata.defaults")}
      footer={
        <Button
          size="sm"
          disabled={readOnly || saving || !daysValid || !(languageChanged || daysChanged)}
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("maintenance.metadata.save")}
        </Button>
      }
    >
      <SettingsRow
        htmlFor="metadata-default-language"
        title={t("maintenance.metadata.defaultLanguage")}
        description={t("maintenance.metadata.defaultLanguageDescription")}
      >
        <NativeSelect
          id="metadata-default-language"
          aria-label={t("maintenance.metadata.defaultLanguage")}
          className="w-full sm:w-48"
          value={language}
          disabled={readOnly || saving}
          onChange={(event) => setLanguage(event.target.value as DlsiteMetadataLanguage)}
        >
          {dlsiteMetadataLanguageOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </NativeSelect>
      </SettingsRow>
      <SettingsRow
        title={t("maintenance.metadata.catalogFreshnessDays")}
        description={t("maintenance.metadata.catalogFreshnessDescription")}
      >
        <SettingsNumberInput
          label={t("maintenance.metadata.catalogFreshnessDays")}
          value={days}
          min={1}
          max={365}
          unit={t("sourceSetup.days")}
          disabled={readOnly || saving}
          onChange={setDays}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
