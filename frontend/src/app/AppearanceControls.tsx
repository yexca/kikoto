import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import type { ThemeMode, ThemePalette, ThemePreset } from "@/app/theme";
import { FloatingSelect } from "@/components/ui/floating-select";

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

export function AppearanceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b p-3 last:border-b-0" role="group" aria-label={label}>
      <div className="mb-2 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
