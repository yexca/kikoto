import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { resolveThemePalette, themePaletteOptions, type ThemePalette, type ThemePreset } from "@/app/theme";
import { cx } from "@/lib/classNames";

/** The selected preset's Original and its alternate accents, each swatch in the current mode's color. */
export function ThemePalettePicker({
  preset,
  value,
  onChange,
}: {
  preset: ThemePreset;
  value: ThemePalette;
  onChange: (palette: ThemePalette) => void;
}) {
  const { t } = useTranslation();
  const selectedPalette = resolveThemePalette(preset, value);
  const options = themePaletteOptions(preset);

  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      aria-label={t("appearance.themeColor")}
    >
      {options.map((option) => {
        const selected = selectedPalette === option.value;
        const label = t(`appearance.palette.${option.value}`);
        return (
          <button
            key={option.value}
            type="button"
            className={cx(
              "flex h-[var(--control-height)] min-w-0 items-center justify-center rounded-[var(--control-radius)] border px-2 transition-[color,background-color,border-color,box-shadow,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100",
              selected
                ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/20"
                : "bg-background text-muted-foreground hover:text-foreground",
            )}
            aria-label={label}
            aria-pressed={selected}
            title={label}
            onClick={() => onChange(option.value)}
          >
            <span
              className="h-4 w-4 shrink-0 rounded-full border border-black/15 bg-[hsl(var(--swatch-light))] shadow-sm dark:border-white/15 dark:bg-[hsl(var(--swatch-dark))]"
              style={{ "--swatch-light": option.accent.light, "--swatch-dark": option.accent.dark } as CSSProperties}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}
