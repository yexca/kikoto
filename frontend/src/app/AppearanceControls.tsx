import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import type { ThemeMode, ThemePalette, ThemePreset } from "@/app/theme";
import { FloatingSelect } from "@/components/ui/floating-select";

/** Mode, style, and color; UI and metadata languages live in the account panel. */
export function AppearanceControls({
  mode,
  preset,
  palette,
  onModeChange,
  onPresetChange,
  onPaletteChange,
}: {
  mode: ThemeMode;
  preset: ThemePreset;
  palette: ThemePalette;
  onModeChange: (mode: ThemeMode) => void;
  onPresetChange: (preset: ThemePreset) => void;
  onPaletteChange: (palette: ThemePalette) => void;
}) {
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
