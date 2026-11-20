import { useTranslation } from "react-i18next";

import { SortControl } from "@/components/collection/SortControl";
import type { LibrarySort, SortDirection } from "@/lib/api";

export type LibrarySortProps = {
  options: { value: LibrarySort; label: string }[];
  value: LibrarySort;
  direction: SortDirection;
  onChange: (value: LibrarySort) => void;
  onDirectionChange: (value: SortDirection) => void;
  onReshuffle: () => void;
  /** True while a reshuffled order is loading. */
  reshuffling?: boolean;
};

/**
 * The Library and creator works order: the shared sort control with the
 * Library's order names. Random and Recommended draw from a seed, so their
 * action is a reshuffle; every other order flips its direction. `size` matches
 * it to an 8 or 10 unit row, and `phone` keeps its menu clear of the bottom
 * navigation and player.
 */
export function LibrarySortButton({
  options,
  value,
  direction,
  onChange,
  onDirectionChange,
  onReshuffle,
  reshuffling = false,
  size = "sm",
  phone = false,
}: LibrarySortProps & { size?: "sm" | "md"; phone?: boolean }) {
  const { t } = useTranslation();
  const seeded = value === "random" || value === "recommend";
  return (
    <SortControl
      options={options.map((option) => ({
        value: option.value,
        label: t(`library.sortOptions.${option.value}`, { defaultValue: option.label }),
      }))}
      value={value}
      direction={direction}
      onChange={onChange}
      onDirectionChange={onDirectionChange}
      reshuffle={
        seeded
          ? {
              label: value === "recommend" ? t("library.refreshRecommendations") : t("library.reshuffle"),
              onReshuffle,
              busy: reshuffling,
            }
          : undefined
      }
      size={size}
      phone={phone}
    />
  );
}
