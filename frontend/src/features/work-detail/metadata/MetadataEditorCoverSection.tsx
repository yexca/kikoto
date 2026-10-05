import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { assetURL, type WorkCoverCandidate, type WorkDetail } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { MetadataEditorField } from "./MetadataEditorFields";
import type { MetadataFieldStatus } from "./metadataEditorModel";

export function coverFieldStatus({
  manualCover,
  selectedCoverId,
  initialCoverId,
  reverted,
}: {
  manualCover?: WorkDetail["manualOverrides"]["cover"];
  selectedCoverId: number | null;
  initialCoverId: number | null;
  reverted: boolean;
}): MetadataFieldStatus {
  if (selectedCoverId !== initialCoverId) return "edited";
  if (reverted) return "reverting";
  return manualCover ? "manual" : "source";
}

// Same-named images often sit in several edition folders, so the folder tells them apart.
function candidateFolder(candidate: WorkCoverCandidate) {
  const path = candidate.path.endsWith(candidate.fileName)
    ? candidate.path.slice(0, -candidate.fileName.length)
    : candidate.path;
  return path.replace(/[\\/]+$/, "");
}

/** Picks a local image as the cover from a thumbnail grid. */
export function MetadataEditorCoverSection({
  manualCover,
  candidates,
  selectedCoverId,
  status,
  loading,
  onSelect,
  onRevert,
  onUndoRevert,
}: {
  manualCover?: WorkDetail["manualOverrides"]["cover"];
  candidates: WorkCoverCandidate[];
  selectedCoverId: number | null;
  status: MetadataFieldStatus;
  loading: boolean;
  onSelect: (locationId: number) => void;
  onRevert: () => void;
  onUndoRevert: () => void;
}) {
  const { t } = useTranslation();
  // A manual cover copied from a file that is no longer indexed still shows as current.
  const orphanedManualCover = manualCover?.url && !candidates.some((candidate) => candidate.selected);
  return (
    <MetadataEditorField
      label={t("libraryDetail.cover")}
      status={status}
      revertLabel={t("libraryDetail.resetCover")}
      onRevert={onRevert}
      onUndoRevert={onUndoRevert}
      hint={t("metadataEditor.coverHint")}
    >
      {orphanedManualCover && (
        <div className="mb-2 flex items-center gap-3 rounded-md border bg-card p-2">
          <img src={assetURL(manualCover.url)} alt="" className="h-14 w-14 shrink-0 rounded object-contain" />
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">{t("metadataEditor.currentCover")}</div>
            <div className="truncate">{manualCover.originalPath || manualCover.assetPath}</div>
          </div>
        </div>
      )}
      {loading ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {t("libraryDetail.loadingCoverCandidates")}
        </p>
      ) : candidates.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {t("libraryDetail.noIndexedLocalImages")}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3 sm:grid-cols-4">
          {candidates.map((candidate) => {
            const selected = selectedCoverId === candidate.locationId;
            return (
              <button
                key={candidate.locationId}
                type="button"
                aria-pressed={selected}
                title={candidate.path}
                className={cn(
                  "group relative flex min-w-0 flex-col overflow-hidden rounded-md border bg-card text-left transition-colors hover:border-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "border-primary ring-2 ring-primary/60 hover:border-primary",
                )}
                onClick={() => onSelect(candidate.locationId)}
              >
                <span className="grid aspect-square place-items-center bg-muted/50">
                  <img
                    src={assetURL(candidate.previewUrl)}
                    alt=""
                    className="h-full w-full object-contain"
                    loading="lazy"
                  />
                </span>
                <span className="min-w-0 px-2 py-1.5 text-xs">
                  <span className="block truncate font-medium">{candidate.fileName}</span>
                  <span className="block truncate text-muted-foreground">
                    {candidateFolder(candidate) || formatBytes(candidate.sizeBytes)}
                  </span>
                </span>
                {candidate.selected && !selected && (
                  <span className="absolute left-1.5 top-1.5 rounded bg-popover/90 px-1.5 py-0.5 text-[11px] font-medium shadow-sm">
                    {t("metadataEditor.currentCover")}
                  </span>
                )}
                {selected && (
                  <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground shadow">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </MetadataEditorField>
  );
}
