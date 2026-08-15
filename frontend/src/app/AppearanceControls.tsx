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
        <div className="space-y-1">
          {UI_LOCALE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="flex min-h-[var(--control-height)] w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-[color,background-color,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100 disabled:cursor-wait disabled:opacity-60"
              aria-pressed={localePreference === option.value}
              disabled={localeBusy}
              onClick={() => void onLocaleChange(option.value)}
            >
              {localeBusy && localePreference === option.value ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <span className="h-4 w-4" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">{t(option.labelKey)}</span>
              {localePreference === option.value && !localeBusy && <CheckCircle2 className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
        {localeError && <p className="mt-2 px-2 text-xs text-destructive">{localeError}</p>}
      </div>
      <div className="p-2" role="group" aria-label={t("appearance.mode")}>
        <AppearanceGroupLabel>{t("appearance.mode")}</AppearanceGroupLabel>
        <ThemeItem
          mode="light"
          label={t("appearance.light")}
          current={mode}
          icon={<Sun className="h-4 w-4" />}
          onSelect={onModeChange}
        />
        <ThemeItem
          mode="dark"
          label={t("appearance.dark")}
          current={mode}
          icon={<Moon className="h-4 w-4" />}
          onSelect={onModeChange}
        />
        <ThemeItem
          mode="system"
          label={t("appearance.system")}
          current={mode}
          icon={<Command className="h-4 w-4" />}
          onSelect={onModeChange}
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

function ThemeItem({
  mode,
  label,
  current,
  icon,
  onSelect,
}: {
  mode: ThemeMode;
  label: string;
  current: ThemeMode;
  icon: ReactNode;
  onSelect: (mode: ThemeMode) => void;
}) {
  return (
    <button
      className="flex min-h-[var(--control-height)] w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-[color,background-color,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100"
      aria-pressed={mode === current}
      onClick={() => onSelect(mode)}
    >
      {icon}
      <span className="min-w-0 flex-1">{label}</span>
      {mode === current && <CheckCircle2 className="h-4 w-4 text-primary" />}
    </button>
  );
}
