import {
  BookOpen,
  Bookmark,
  Cat,
  CloudRain,
  Coffee,
  Crown,
  Ear,
  Flame,
  Flower2,
  Footprints,
  Gamepad2,
  Gift,
  Headphones,
  Heart,
  Laptop,
  Leaf,
  ListMusic,
  Mic,
  Moon,
  Repeat,
  Snowflake,
  Sparkles,
  Star,
  Sun,
  TrainFront,
  Waves,
  type LucideIcon,
} from "lucide-react";

import type { FavoriteList } from "@/lib/api";

/**
 * Icons a user list can show. The server stores only the key, so a key this
 * client does not know, or an empty one, falls back to the default list icon.
 * Keys are persisted: rename the label, never the key.
 */
export const favoriteListIconOptions = [
  { key: "heart", icon: Heart },
  { key: "star", icon: Star },
  { key: "sparkles", icon: Sparkles },
  { key: "moon", icon: Moon },
  { key: "sun", icon: Sun },
  { key: "coffee", icon: Coffee },
  { key: "cloud-rain", icon: CloudRain },
  { key: "waves", icon: Waves },
  { key: "leaf", icon: Leaf },
  { key: "flower", icon: Flower2 },
  { key: "snowflake", icon: Snowflake },
  { key: "flame", icon: Flame },
  { key: "headphones", icon: Headphones },
  { key: "ear", icon: Ear },
  { key: "mic", icon: Mic },
  { key: "book-open", icon: BookOpen },
  { key: "train", icon: TrainFront },
  { key: "footprints", icon: Footprints },
  { key: "laptop", icon: Laptop },
  { key: "gamepad", icon: Gamepad2 },
  { key: "repeat", icon: Repeat },
  { key: "bookmark", icon: Bookmark },
  { key: "gift", icon: Gift },
  { key: "cat", icon: Cat },
  { key: "crown", icon: Crown },
] as const satisfies readonly { key: string; icon: LucideIcon }[];

export type FavoriteListIconKey = (typeof favoriteListIconOptions)[number]["key"];

export const defaultFavoriteListIcon: LucideIcon = ListMusic;

const iconsByKey = new Map<string, LucideIcon>(favoriteListIconOptions.map((option) => [option.key, option.icon]));

export function isFavoriteListIconKey(key: string): key is FavoriteListIconKey {
  return iconsByKey.has(key);
}

export function favoriteListIcon(list: Pick<FavoriteList, "icon"> | null | undefined): LucideIcon {
  return iconsByKey.get(list?.icon ?? "") ?? defaultFavoriteListIcon;
}
