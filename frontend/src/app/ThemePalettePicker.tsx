import { THEME_PALETTE_OPTIONS, THEME_PRESET_OPTIONS, type ThemePalette, type ThemePreset } from "@/app/theme";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export function ThemePalettePicker({
  preset,
  value,
  onChange,
  compact = false,
}: {
  preset: ThemePreset;
  value: ThemePalette;
  onChange: (palette: ThemePalette) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const originalSwatch =
    THEME_PRESET_OPTIONS.find((option) => option.value === preset)?.swatches[0] ?? THEME_PRESET_OPTIONS[0].swatches[0];

  return (
    <div className={cn("grid gap-2", compact ? "grid-cols-4" : "grid-cols-2")} aria-label={t("appearance.themeColor")}>
      {THEME_PALETTE_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={cn(
              "flex min-w-0 items-center justify-center gap-2 rounded-[var(--control-radius)] border transition-[color,background-color,border-color,box-shadow,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100",
              compact ? "h-[var(--control-height)] px-2" : "min-h-[var(--control-height)] px-3 text-sm font-medium",
              selected
                ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/20"
                : "bg-background text-muted-foreground hover:text-foreground",
            )}
            aria-label={option.label}
            aria-pressed={selected}
            title={compact ? option.label : undefined}
            onClick={() => onChange(option.value)}
          >
            <span
              className="h-4 w-4 shrink-0 rounded-full border border-black/15 shadow-sm"
              style={{ backgroundColor: option.swatch ?? originalSwatch }}
              aria-hidden="true"
            />
            {compact ? (
              <span className="sr-only">{option.label}</span>
            ) : (
              <span className="truncate">{option.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
