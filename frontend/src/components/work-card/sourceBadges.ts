import type { CircleSourceStat, SourcePresenceItem } from "@/lib/api";
import i18n from "@/i18n";

import type { WorkCardBadge } from "./WorkCardShell";

export function sourcePresenceBadges(
  sourcePresence: SourcePresenceItem[] | null | undefined,
  availability: string[] = [],
): WorkCardBadge[] {
  const items = sourcePresence ?? [];
  const hasPlayable = hasPlayableAvailability(availability);
  const badges: WorkCardBadge[] = [];
  const seen = new Set<string>();
  const add = (badge: WorkCardBadge) => {
    const key = badge.key ?? badge.label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    badges.push(badge);
  };

  for (const item of items) {
    const badge = presenceBadge(item, hasPlayable);
    if (badge) add(badge);
  }

  if (badges.length > 0) return sortSourceBadges(badges);
  if (items.length === 0 && !hasPlayableAvailability(availability)) {
    return [{ key: "source:no-source", label: i18n.t("workCard.noSource"), variant: "warning" }];
  }
  return sortSourceBadges(availabilityBadges(availability));
}

function presenceBadge(item: SourcePresenceItem, hasPlayable: boolean): WorkCardBadge | null {
  const type = normalizePresenceType(item.type);
  const availability = item.availability || "unknown";
  if (type === "local") {
    return {
      key: "source:local",
      label: i18n.t("workCard.local"),
      variant: availability === "available" ? "secondary" : "warning",
      title: i18n.t("workCard.localSource"),
    };
  }
  if (type === "tracked") return trackedPresenceBadge(item, availability, hasPlayable);
  if (type === "source") {
    const sourceName = item.fileSourceName || item.fileSourceCode || i18n.t("workCard.remoteSource");
    return {
      key: `source:${item.fileSourceId ?? sourceName}`,
      label: sourceName,
      variant: availability === "available" ? "outline" : "warning",
    };
  }
  if (!type || type === "remote") return null;
  return { key: `source:${type}`, label: type, variant: availability === "available" ? "outline" : "warning" };
}

function trackedPresenceBadge(item: SourcePresenceItem, availability: string, hasPlayable: boolean) {
  if (availability !== "available") return null;
  const sourceName = item.fileSourceName || item.fileSourceCode || "";
  const unforked = !hasPlayable;
  return {
    key: `source:tracked:${item.fileSourceId ?? (sourceName || "unknown")}`,
    label: unforked ? i18n.t("workCard.unforked") : i18n.t("workCard.tracked"),
    variant: unforked ? ("warning" as const) : ("outline" as const),
    title: sourceName || undefined,
  };
}

export function circleSourceBadges({
  local,
  remote,
  cache,
  sourceTags = [],
}: {
  local?: boolean;
  remote?: boolean;
  cache?: boolean;
  sourceTags?: CircleSourceStat[] | null;
}): WorkCardBadge[] {
  const badges: WorkCardBadge[] = [];
  if (local)
    badges.push({
      key: "source:local",
      label: i18n.t("workCard.local"),
      variant: "secondary",
      title: i18n.t("workCard.localSource"),
    });

  const availableSources = (sourceTags ?? []).filter((source) => source.status === "available" || source.count > 0);
  for (const source of availableSources) {
    if (source.key === "local" || source.key === "cache" || source.key === "remote") continue;
    if (source.sourceId !== null && source.sourceId !== undefined) {
      badges.push({
        key: `source:remote:${source.sourceId}`,
        label: source.displayName || source.key,
        variant: "outline",
      });
    }
  }

  if (cache) badges.push({ key: "source:cache", label: i18n.t("workCard.cache"), variant: "secondary" });
  return sortSourceBadges(dedupeBadges(badges));
}

function availabilityBadges(availability: string[]): WorkCardBadge[] {
  const badges: WorkCardBadge[] = [];
  for (const item of availability) {
    const normalized = item.toLowerCase();
    if (normalized === "remote") continue;
    if (normalized === "local") {
      badges.push({ key: "source:local", label: i18n.t("workCard.local"), variant: "secondary" });
    } else if (normalized === "cache" || normalized === "cached") {
      badges.push({ key: "source:cache", label: i18n.t("workCard.cache"), variant: "secondary" });
    } else if (normalized === "missing") {
      badges.push({ key: "source:missing", label: i18n.t("workCard.missing"), variant: "warning" });
    } else {
      badges.push({ key: `source:${normalized}`, label: item, variant: "outline" });
    }
  }
  return badges;
}

function normalizePresenceType(type: string) {
  const normalized = type.toLowerCase();
  return normalized;
}

function hasPlayableAvailability(availability: string[]) {
  return availability.some((item) => ["local", "cache", "cached", "remote"].includes(item.toLowerCase()));
}

function dedupeBadges(badges: WorkCardBadge[]) {
  const seen = new Set<string>();
  return badges.filter((badge) => {
    const key = badge.key ?? badge.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortSourceBadges(badges: WorkCardBadge[]) {
  return [...badges].sort(
    (left, right) => sourceBadgeRank(left) - sourceBadgeRank(right) || left.label.localeCompare(right.label),
  );
}

function sourceBadgeRank(badge: WorkCardBadge) {
  const key = badge.key ?? "";
  if (key.startsWith("source:local")) return 0;
  if (key.startsWith("source:tracked")) return 1;
  if (key.startsWith("source:remote")) return 2;
  if (key.startsWith("source:cache")) return 3;
  if (key.startsWith("source:missing")) return 4;
  if (key.startsWith("source:no-source")) return 4;
  if (key.startsWith("source:")) return 2;
  return 5;
}
