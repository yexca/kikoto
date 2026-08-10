import type { MouseEventHandler } from "react";
import { Palette } from "lucide-react";

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
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Open appearance settings"
      title={`Appearance: ${themeModeLabel(mode)}, ${themePresetLabel(preset)}, ${themePaletteLabel(palette)}`}
      onClick={onClick}
    >
      <Palette className="h-4 w-4" />
    </Button>
  );
}

function themeModeLabel(mode: ThemeMode) {
  return mode === "system" ? "System" : mode === "dark" ? "Dark" : "Light";
}
