import { Globe } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import type { ThemeMode, ThemePalette, ThemePreset } from "@/app/theme";
import { FloatingSelect } from "@/components/ui/floating-select";
import { UI_LOCALE_OPTIONS, type UiLocale } from "@/i18n";

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
