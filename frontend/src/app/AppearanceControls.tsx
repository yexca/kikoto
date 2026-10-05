import { Globe } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import type { ThemeMode, ThemePalette, ThemePreset } from "@/app/theme";
import { FloatingSelect } from "@/components/ui/floating-select";
import {
  dlsiteMetadataLanguageLabelKey,
  dlsiteMetadataLanguageOptions,
  type DlsiteMetadataLanguage,
  type MetadataLanguageChoice,
} from "@/features/maintenance/metadataLanguageModel";
import { UI_LOCALE_OPTIONS, type UiLocale } from "@/i18n";

/** The signed-in user's own metadata language, or the instance default. */
export type MetadataLanguageControl = {
  value: MetadataLanguageChoice | null;
  /** The instance default named by the "default" choice. */
  defaultValue: DlsiteMetadataLanguage | null;
  busy: boolean;
  failed: boolean;
  readOnly: boolean;
  onChange: (value: MetadataLanguageChoice) => void | Promise<void>;
};

export function AppearanceControls({
  mode,
  preset,
  palette,
  onModeChange,
  onPresetChange,
  onPaletteChange,
  localePreference = "auto",
  onLocaleChange = () => undefined,
  localeBusy = false,
  localeError = "",
  metadataLanguage,
}: {
  mode: ThemeMode;
  preset: ThemePreset;
  palette: ThemePalette;
  onModeChange: (mode: ThemeMode) => void;
  onPresetChange: (preset: ThemePreset) => void;
  onPaletteChange: (palette: ThemePalette) => void;
  localePreference?: UiLocale;
  onLocaleChange?: (locale: UiLocale) => void | Promise<void>;
  localeBusy?: boolean;
  localeError?: string;
  metadataLanguage?: MetadataLanguageControl;
}) {
  const { t } = useTranslation();
  return (
    <>
      <AppearanceGroup label={t("appearance.language")}>
        <FloatingSelect
          value={localePreference}
          disabled={localeBusy}
          ariaBusy={localeBusy}
          ariaInvalid={Boolean(localeError)}
          ariaLabel={t("appearance.language")}
          onValueChange={(value) => void onLocaleChange(value as UiLocale)}
          className="disabled:cursor-wait"
          options={UI_LOCALE_OPTIONS.map((option) => ({
            value: option.value,
            label:
              option.value === "auto" ? (
                <span title={t(option.labelKey)}>
                  <Globe className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">{t(option.labelKey)}</span>
                </span>
              ) : (
                t(option.labelKey)
              ),
          }))}
        />
        {localeError && <p className="mt-2 text-xs text-destructive">{localeError}</p>}
      </AppearanceGroup>
      {metadataLanguage && (
        <AppearanceGroup label={t("appearance.metadataLanguage")}>
          <FloatingSelect
            value={metadataLanguage.value ?? "default"}
            disabled={metadataLanguage.readOnly || metadataLanguage.busy || metadataLanguage.value === null}
            ariaBusy={metadataLanguage.busy || (metadataLanguage.value === null && !metadataLanguage.failed)}
            ariaInvalid={metadataLanguage.failed}
            ariaLabel={t("appearance.metadataLanguage")}
            onValueChange={(value) => void metadataLanguage.onChange(value as MetadataLanguageChoice)}
            className={metadataLanguage.busy ? "disabled:cursor-wait" : undefined}
            options={[
              {
                value: "default",
                label: t("appearance.metadataLanguageDefault", {
                  language: t(dlsiteMetadataLanguageLabelKey(metadataLanguage.defaultValue ?? "origin")),
                }),
              },
              ...dlsiteMetadataLanguageOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              })),
            ]}
          />
          {metadataLanguage.failed && (
            <p className="mt-2 text-xs text-destructive">
              {t(
                metadataLanguage.value === null
                  ? "appearance.metadataLanguageLoadFailed"
                  : "appearance.metadataLanguageSaveFailed",
              )}
            </p>
          )}
        </AppearanceGroup>
      )}
      <AppearanceGroup label={t("appearance.mode")}>
        <FloatingSelect
          value={mode}
          ariaLabel={t("appearance.mode")}
          onValueChange={(value) => onModeChange(value as ThemeMode)}
          options={[
            { value: "light", label: t("appearance.light") },
            { value: "dark", label: t("appearance.dark") },
            { value: "system", label: t("appearance.system") },
          ]}
        />
      </AppearanceGroup>
      <AppearanceGroup label={t("appearance.style")}>
        <ThemePresetPicker value={preset} onChange={onPresetChange} compact />
      </AppearanceGroup>
      <AppearanceGroup label={t("appearance.color")}>
        <ThemePalettePicker preset={preset} value={palette} onChange={onPaletteChange} compact />
      </AppearanceGroup>
    </>
  );
}

function AppearanceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b p-3 last:border-b-0" role="group" aria-label={label}>
      <div className="mb-2 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
