import { sortSourceBadges, sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import type { WorkCardBadge } from "@/components/work-card/WorkCardShell";
import i18n from "@/i18n";
import type { RemoteWork } from "@/lib/api";

/**
 * Source marks for a remote-source card: the browsed source's own mark plus
 * the marks the work's Library card shows. The browsed source stands in for
 * its own catalog listing, and a source that serves the work makes the
 * library's "no source" and "missing" fallbacks untrue for this card.
 */
export function remoteWorkSourceBadges(work: RemoteWork, sourceId: number, sourceLabel: string): WorkCardBadge[] {
  const own: WorkCardBadge = work.remotePlayable
    ? { key: `source:remote:${sourceId}`, label: sourceLabel, variant: "outline" }
    : {
        key: `source:remote:${sourceId}:unavailable`,
        label: i18n.t("workCard.namedSourceUnavailable", { name: sourceLabel }),
        variant: "warning",
      };
  if (work.workId === null) return [own];
  const omitted = new Set([`source:${sourceId}`, "source:no-source", "source:missing"]);
  const library = sourcePresenceBadges(work.sourcePresence, work.availability).filter(
    (badge) => !omitted.has(badge.key ?? ""),
  );
  return sortSourceBadges([own, ...library]);
}
