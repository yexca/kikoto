import { Circle, Feather, Layers3, Shapes, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { THEME_PRESET_OPTIONS, type ThemePreset } from "@/app/theme";
import { cx } from "@/lib/classNames";

const presetIcons: Record<ThemePreset, LucideIcon> = {
  anthropic: Feather,
  openai: Circle,
  apple: Layers3,
  "google-md": Shapes,
};

export function ThemePresetPicker({
  value,
  onChange,
}: {
  value: ThemePreset;
  onChange: (preset: ThemePreset) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2" aria-label={t("appearance.themeStyle")}>
      {THEME_PRESET_OPTIONS.map((option) => {
        const Icon = presetIcons[option.value];
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={cx(
              "group flex min-h-[var(--control-height)] min-w-0 items-center gap-2 rounded-md border px-2 text-left transition-[color,background-color,border-color,box-shadow,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100",
              selected
                ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/20"
                : "bg-background text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="block min-w-0 flex-1 truncate text-xs font-medium">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
