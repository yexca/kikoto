import type { CircleSourceStat, SourcePresenceItem } from "@/lib/api";

import type { WorkCardBadge } from "./WorkCardShell";

export function sourcePresenceBadges(
  sourcePresence: SourcePresenceItem[] | null | undefined,
  availability: string[] = [],
): WorkCardBadge[] {
  const items = sourcePresence ?? [];
  const badges: WorkCardBadge[] = [];
  const seen = new Set<string>();
  const add = (badge: WorkCardBadge) => {
    const key = badge.key ?? badge.label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    badges.push(badge);
  };

  for (const item of items) {
    const type = normalizePresenceType(item.type);
    const availabilityLabel = item.availability || "unknown";
    if (type === "local") {
      add({ key: "source:local", label: "Local", variant: availabilityLabel === "available" ? "secondary" : "warning", title: "Local source" });
      continue;
    }
    if (type === "tracked") {
      const sourceName = item.fileSourceName || item.fileSourceCode || "";
      const unforked = availabilityLabel !== "available" || !hasPlayableAvailability(availability);
      add({
        key: `source:tracked:${item.fileSourceId ?? (sourceName || "unknown")}`,
        label: unforked ? "Unforked" : "Tracked",
        variant: unforked ? "warning" : "outline",
        title: sourceName || undefined,
      });
      continue;
    }
    if (type === "remote") {
      const sourceName = item.fileSourceName || item.fileSourceCode || "remote source";
      add({
        key: `source:remote:${item.fileSourceId ?? sourceName}`,
        label: sourceName,
        variant: availabilityLabel === "available" ? "outline" : "warning",
      });
      continue;
    }
    if (type) {
      add({ key: `source:${type}`, label: type, variant: availabilityLabel === "available" ? "outline" : "warning" });
    }
  }

  if (badges.length > 0) return sortSourceBadges(badges);
  return sortSourceBadges(availabilityBadges(availability));
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
  sourceTags?: CircleSourceStat[];
}): WorkCardBadge[] {
  const badges: WorkCardBadge[] = [];
  if (local) badges.push({ key: "source:local", label: "Local", variant: "secondary", title: "Local source" });

  const availableSources = sourceTags.filter((source) => source.status === "available" || source.count > 0);
  for (const source of availableSources) {
    if (source.key === "local" || source.key === "cache") continue;
    if (source.sourceId !== null && source.sourceId !== undefined) {
      badges.push({
        key: `source:remote:${source.sourceId}`,
        label: source.displayName || source.key,
        variant: "outline",
      });
    }
  }

  if (cache) badges.push({ key: "source:cache", label: "Cache", variant: "secondary" });
  if (badges.length === 0 && remote) {
    badges.push({ key: "source:remote:legacy", label: "Remote", variant: "outline", title: "Legacy remote availability" });
  }
  return sortSourceBadges(dedupeBadges(badges));
}

function availabilityBadges(availability: string[]): WorkCardBadge[] {
  return availability.map((item) => {
    const normalized = item.toLowerCase();
    if (normalized === "local") return { key: "source:local", label: "Local", variant: "secondary" };
    if (normalized === "cache" || normalized === "cached") return { key: "source:cache", label: "Cache", variant: "secondary" };
    if (normalized === "remote") return { key: "source:remote:legacy", label: "Remote", variant: "outline", title: "Legacy remote availability" };
    if (normalized === "missing") return { key: "source:missing", label: "Missing", variant: "warning" };
    return { key: `source:${normalized}`, label: item, variant: "outline" };
  });
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
  return [...badges].sort((left, right) => sourceBadgeRank(left) - sourceBadgeRank(right) || left.label.localeCompare(right.label));
}

function sourceBadgeRank(badge: WorkCardBadge) {
  const key = badge.key ?? "";
  if (key.startsWith("source:local")) return 0;
  if (key.startsWith("source:tracked")) return 1;
  if (key.startsWith("source:remote")) return 2;
  if (key.startsWith("source:cache")) return 3;
  if (key.startsWith("source:missing")) return 4;
  return 5;
}
