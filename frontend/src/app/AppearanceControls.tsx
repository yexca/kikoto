import { CheckCircle2, Command, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";

import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import type { ThemeMode, ThemePalette, ThemePreset } from "@/app/theme";

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
  return (
    <>
      <div className="p-2" role="group" aria-label="Mode">
        <AppearanceGroupLabel>Mode</AppearanceGroupLabel>
        <ThemeItem mode="light" current={mode} icon={<Sun className="h-4 w-4" />} onSelect={onModeChange} />
        <ThemeItem mode="dark" current={mode} icon={<Moon className="h-4 w-4" />} onSelect={onModeChange} />
        <ThemeItem mode="system" current={mode} icon={<Command className="h-4 w-4" />} onSelect={onModeChange} />
      </div>
      <div className="border-t p-3">
        <div role="group" aria-label="Style">
          <AppearanceGroupLabel>Style</AppearanceGroupLabel>
          <ThemePresetPicker value={preset} onChange={onPresetChange} compact />
        </div>
        <div className="mt-3 border-t pt-3" role="group" aria-label="Color">
          <AppearanceGroupLabel>Color</AppearanceGroupLabel>
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
  current,
  icon,
  onSelect,
}: {
  mode: ThemeMode;
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
      <span className="min-w-0 flex-1 capitalize">{mode}</span>
      {mode === current && <CheckCircle2 className="h-4 w-4 text-primary" />}
    </button>
  );
}
