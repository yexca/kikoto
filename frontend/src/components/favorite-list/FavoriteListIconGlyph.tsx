import type { FavoriteList } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { favoriteListIcon } from "./favoriteListIcons";

/** A list's chosen icon beside its name; decorative, since the name labels the row. */
export function FavoriteListIconGlyph({ list, className }: { list: Pick<FavoriteList, "icon">; className?: string }) {
  const Icon = favoriteListIcon(list);
  return <Icon className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} aria-hidden="true" />;
}
