import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import type { ThemeMode, ThemePalette, ThemePreset } from "@/app/theme";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
        <Select
          value={localePreference}
          disabled={localeBusy}
          onValueChange={(value) => void onLocaleChange(value as UiLocale)}
        >
          <SelectTrigger
            className="disabled:cursor-wait"
            aria-busy={localeBusy}
            aria-invalid={Boolean(localeError)}
            aria-label={t("appearance.language")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UI_LOCALE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {localeError && <p className="mt-2 px-2 text-xs text-destructive">{localeError}</p>}
      </div>
      <div className="p-2" role="group" aria-label={t("appearance.mode")}>
        <AppearanceGroupLabel>{t("appearance.mode")}</AppearanceGroupLabel>
        <Select value={mode} onValueChange={(value) => onModeChange(value as ThemeMode)}>
          <SelectTrigger aria-label={t("appearance.mode")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">{t("appearance.light")}</SelectItem>
            <SelectItem value="dark">{t("appearance.dark")}</SelectItem>
            <SelectItem value="system">{t("appearance.system")}</SelectItem>
          </SelectContent>
        </Select>
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
