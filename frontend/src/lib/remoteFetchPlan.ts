import type { RemoteWorkSavePlan } from "@/lib/api";

export function hasRemoteFetchConflicts(plan: RemoteWorkSavePlan) {
  return plan.fetchRoot.conflict || plan.summary.conflict > 0 || plan.items.some((item) => item.targetConflict);
}

export function formatRemoteFetchPlanConflict(plan: RemoteWorkSavePlan) {
  const details: string[] = [];
  if (plan.fetchRoot.conflict) {
    const root = plan.fetchRoot.rootPath ? `${plan.fetchRoot.rootPath}: ` : "";
    details.push(`${root}${plan.fetchRoot.message || "the Fetch folder requires review"}`);
  }
  const conflicts = plan.items.filter((item) => item.targetConflict);
  const preview = conflicts
    .slice(0, 3)
    .map((item) => `${item.targetPath}: ${item.targetConflictReason || item.status}`)
    .join("; ");
  if (preview) details.push(preview);
  const suffix = conflicts.length > 3 ? `; +${conflicts.length - 3} more` : "";
  if (details.length === 0) return "Fetch is blocked because its plan requires review.";
  return `Fetch blocked because its destination requires review. ${details.join("; ")}${suffix}`;
}
