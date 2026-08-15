import type { MouseEventHandler } from "react";
import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { themePaletteLabel, themePresetLabel, type ThemeMode, type ThemePalette, type ThemePreset } from "@/app/theme";

export function ThemeTrigger({
  mode,
  preset,
  palette,
  onClick,
}: {
  mode: ThemeMode;
  preset: ThemePreset;
  palette: ThemePalette;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  const modeLabel = t(`appearance.${mode}`, { defaultValue: themeModeLabel(mode) });
  const appearanceSummary = t("appearance.summary", {
    defaultValue: "Appearance: {{mode}}, {{style}}, {{color}}",
    mode: modeLabel,
    style: themePresetLabel(preset),
    color: themePaletteLabel(palette),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={t("appearance.openSettings", { defaultValue: "Open appearance settings" })}
      title={
        appearanceSummary.includes("{{")
          ? `Appearance: ${modeLabel}, ${themePresetLabel(preset)}, ${themePaletteLabel(palette)}`
          : appearanceSummary
      }
      onClick={onClick}
    >
      <Palette className="h-4 w-4" />
    </Button>
  );
}

function themeModeLabel(mode: ThemeMode) {
  return mode === "system" ? "System" : mode === "dark" ? "Dark" : "Light";
}
