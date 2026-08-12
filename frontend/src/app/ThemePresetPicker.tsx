import { Circle, Feather, Layers3, Shapes, type LucideIcon } from "lucide-react";

import { THEME_PRESET_OPTIONS, type ThemePalette, type ThemePreset } from "@/app/theme";
import { cn } from "@/lib/utils";

const presetIcons: Record<ThemePreset, LucideIcon> = {
  anthropic: Feather,
  openai: Circle,
  apple: Layers3,
  "google-md": Shapes,
};

export function ThemePresetPicker({
  value,
  onChange,
  palette = "original",
  compact = false,
}: {
  value: ThemePreset;
  onChange: (preset: ThemePreset) => void;
  palette?: ThemePalette;
  compact?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2" aria-label="Theme style">
      {THEME_PRESET_OPTIONS.map((option) => {
        const Icon = presetIcons[option.value];
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={cn(
              "group flex min-w-0 items-center gap-2 rounded-md border text-left transition-[color,background-color,border-color,box-shadow,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100",
              compact ? "min-h-[var(--control-height)] px-2" : "min-h-14 px-3",
              selected
                ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/20"
                : "bg-background text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
          >
            <Icon className={cn("shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate font-medium", compact ? "text-xs" : "text-sm")}>{option.label}</span>
              {!compact && (
                <span className="mt-1 flex gap-1" aria-hidden="true">
                  {[option.previewAccents[palette], option.swatches[1], option.swatches[2]].map((swatch) => (
                    <span
                      key={swatch}
                      className="h-1.5 flex-1 rounded-full border border-black/10 shadow-sm"
                      style={{ backgroundColor: swatch }}
                    />
                  ))}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
