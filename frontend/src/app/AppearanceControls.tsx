import type { ReactNode } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import type { ThemeMode, ThemePalette, ThemePreset } from "@/app/theme";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";

const modeOptions: ReadonlyArray<{ value: ThemeMode; icon: LucideIcon }> = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

export type AppearanceControl = {
  mode: ThemeMode;
  preset: ThemePreset;
  palette: ThemePalette;
  onModeChange: (mode: ThemeMode) => void;
  onPresetChange: (preset: ThemePreset) => void;
  onPaletteChange: (palette: ThemePalette) => void;
};

/** Mode, style, and color; the account panel shows them in its Appearance view. */
export function AppearanceControls({
  mode,
  preset,
  palette,
  onModeChange,
  onPresetChange,
  onPaletteChange,
}: AppearanceControl) {
  const { t } = useTranslation();
  return (
    <>
      <AppearanceGroup label={t("appearance.mode")}>
        <div role="radiogroup" aria-label={t("appearance.mode")} className={segmentedListClassName("w-full")}>
          {modeOptions.map(({ value, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={segmentedItemClassName(
                mode === value,
                "min-w-0 flex-auto justify-center gap-1 px-1.5 text-xs",
              )}
              onClick={() => onModeChange(value)}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t(`appearance.${value}`)}</span>
            </button>
          ))}
        </div>
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

export function AppearanceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b p-3 last:border-b-0" role="group" aria-label={label}>
      <div className="mb-2 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
