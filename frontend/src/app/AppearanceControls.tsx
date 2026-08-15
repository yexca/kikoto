import { CheckCircle2, Command, Loader2, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import type { ThemeMode, ThemePalette, ThemePreset } from "@/app/theme";
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
        <select
          className="h-[var(--control-height)] w-full rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:cursor-wait disabled:opacity-60"
          value={localePreference}
          disabled={localeBusy}
          aria-busy={localeBusy}
          aria-label={t("appearance.language")}
          onChange={(event) => void onLocaleChange(event.target.value as UiLocale)}
        >
          {UI_LOCALE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
        {localeError && <p className="mt-2 px-2 text-xs text-destructive">{localeError}</p>}
      </div>
      <div className="p-2" role="group" aria-label={t("appearance.mode")}>
        <AppearanceGroupLabel>{t("appearance.mode")}</AppearanceGroupLabel>
        <select
          className="h-[var(--control-height)] w-full rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={mode}
          aria-label={t("appearance.mode")}
          onChange={(event) => onModeChange(event.target.value as ThemeMode)}
        >
          <option value="light">{t("appearance.light")}</option>
          <option value="dark">{t("appearance.dark")}</option>
          <option value="system">{t("appearance.system")}</option>
        </select>
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
