import type { RemoteWorkSavePlan } from "@/lib/api";

export function hasRemoteFetchConflicts(plan: RemoteWorkSavePlan) {
  return plan.summary.conflict > 0 || plan.items.some((item) => item.targetConflict);
}

export function formatRemoteFetchPlanConflict(plan: RemoteWorkSavePlan) {
  const conflicts = plan.items.filter((item) => item.targetConflict);
  if (conflicts.length === 0) return "";
  const preview = conflicts
    .slice(0, 3)
    .map((item) => `${item.targetPath}: ${item.targetConflictReason || item.status}`)
    .join("; ");
  const suffix = conflicts.length > 3 ? `; +${conflicts.length - 3} more` : "";
  return `Fetch blocked because target files would conflict. ${preview}${suffix}`;
}
