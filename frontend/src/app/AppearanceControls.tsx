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
      <div className="border-b p-3" role="group" aria-label={t("appearance.language")}>
        <AppearanceGroupLabel>{t("appearance.language")}</AppearanceGroupLabel>
        <p className="mb-2 px-2 text-xs text-muted-foreground">{t("appearance.languageDescription")}</p>
        <FloatingSelect
          value={localePreference}
          disabled={localeBusy}
          ariaBusy={localeBusy}
          ariaInvalid={Boolean(localeError)}
          ariaLabel={t("appearance.language")}
          onValueChange={(value) => void onLocaleChange(value as UiLocale)}
          className="disabled:cursor-wait"
          options={UI_LOCALE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
        />
        {localeError && <p className="mt-2 px-2 text-xs text-destructive">{localeError}</p>}
      </div>
      <div className="p-2" role="group" aria-label={t("appearance.mode")}>
        <AppearanceGroupLabel>{t("appearance.mode")}</AppearanceGroupLabel>
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
      </div>
      <div className="border-t p-3">
        <div role="group" aria-label={t("appearance.style")}>
          <AppearanceGroupLabel>{t("appearance.style")}</AppearanceGroupLabel>
          <ThemePresetPicker value={preset} onChange={onPresetChange} compact />
        </div>
        <div className="mt-3 border-t pt-3" role="group" aria-label={t("appearance.color")}>
          <AppearanceGroupLabel>{t("appearance.color")}</AppearanceGroupLabel>
          <ThemePalettePicker preset={preset} value={palette} onChange={onPaletteChange} compact />
        </div>
      </div>
    </>
  );
}

function AppearanceGroupLabel({ children }: { children: ReactNode }) {
  return <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">{children}</div>;
}
