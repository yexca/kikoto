import { useId } from "react";
import { useTranslation } from "react-i18next";

import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { FOR_YOU_TEMPERATURES, type ForYouTemperature } from "@/lib/forYouApi";

/** The For you temperature: its name followed by the steps 1 to 5 in one row. */
export function ForYouTemperaturePicker({
  value,
  onChange,
}: {
  /** Null until the saved choice has loaded. */
  value: ForYouTemperature | null;
  onChange: (value: ForYouTemperature) => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span id={labelId} className="shrink-0 text-xs font-medium text-muted-foreground">
        {t("subscriptions.forYou.temperature.label")}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className={segmentedListClassName("bg-transparent p-0")}>
        {FOR_YOU_TEMPERATURES.map((item) => {
          const checked = item === value;
          return (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={value === null}
              className={segmentedItemClassName(checked, "w-7 justify-center px-0 tabular-nums")}
              onClick={() => {
                if (!checked) onChange(item);
              }}
            >
              {item}
            </button>
          );
        })}
      </div>
    </div>
  );
}
