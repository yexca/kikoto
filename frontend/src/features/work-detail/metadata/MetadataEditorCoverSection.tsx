import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ImageOff } from "lucide-react";
import { assetURL, type WorkCoverCandidate, type WorkDetail } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { MetadataEditorField } from "./MetadataEditorFields";
import type { CoverChoice, MetadataFieldStatus } from "./metadataEditorModel";

// Same-named images often sit in several edition folders, so the folder tells them apart.
function candidateFolder(path: string, fileName: string) {
  const folder = path.endsWith(fileName) ? path.slice(0, -fileName.length) : path;
  return folder.replace(/[\\/]+$/, "");
}

function fileNameOf(path: string) {
  return path.split(/[\\/]/).pop() ?? "";
}

function CoverTile({
  selected,
  current,
  imageUrl,
  title,
  detail,
  path,
  onSelect,
}: {
  selected: boolean;
  current: boolean;
  imageUrl: string;
  title: string;
  detail: ReactNode;
  path?: string;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={path}
      className={cn(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-md border bg-card text-left transition-colors hover:border-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary ring-2 ring-primary/60 hover:border-primary",
      )}
      onClick={onSelect}
    >
      <span className="grid aspect-square place-items-center bg-muted/50">
        {imageUrl ? (
          <img src={assetURL(imageUrl)} alt="" className="h-full w-full object-contain" loading="lazy" />
        ) : (
          <ImageOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 px-2 py-1.5 text-xs">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-muted-foreground">{detail}</span>
      </span>
      {current && !selected && (
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
}

/**
 * Picks the cover from a thumbnail grid: the provider's original cover first,
 * then a manual cover that is no longer indexed, then each local image.
 */
export function MetadataEditorCoverSection({
  manualCover,
  providerCoverUrl,
  providerSource,
  candidates,
  selected,
  status,
  loading,
  onSelect,
}: {
  manualCover?: WorkDetail["manualOverrides"]["cover"];
  providerCoverUrl: string;
  /** Remote source that filled the cover, or empty for DLsite. */
  providerSource: string;
  candidates: WorkCoverCandidate[];
  selected: CoverChoice;
  status: MetadataFieldStatus;
  loading: boolean;
  onSelect: (choice: CoverChoice) => void;
}) {
  const { t } = useTranslation();
  // A manual cover copied from a file that is no longer indexed still shows as current.
  const orphanedManualCover = manualCover?.url && !candidates.some((candidate) => candidate.selected);
  const showProvider = Boolean(providerCoverUrl || manualCover);
  const manualPath = manualCover?.originalPath || manualCover?.assetPath || "";
  return (
    <MetadataEditorField
      label={t("libraryDetail.cover")}
      status={status}
      revertLabel={t("libraryDetail.resetCover")}
      onRevert={() => onSelect("provider")}
      hint={status === "reverting" ? t("metadataEditor.coverRevertHint") : t("metadataEditor.coverHint")}
    >
      {loading ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {t("libraryDetail.loadingCoverCandidates")}
        </p>
      ) : (
        <div className="space-y-2">
          {(showProvider || orphanedManualCover || candidates.length > 0) && (
            <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3 sm:grid-cols-4">
              {showProvider && (
                <CoverTile
                  selected={selected === "provider"}
                  current={!manualCover}
                  imageUrl={providerCoverUrl}
                  title={
                    providerSource
                      ? t("metadataEditor.sourceCover", { source: providerSource })
                      : t("metadataEditor.dlsiteCover")
                  }
                  detail={providerCoverUrl ? t("metadataEditor.originalCover") : t("metadataEditor.coverNotDownloaded")}
                  onSelect={() => onSelect("provider")}
                />
              )}
              {orphanedManualCover && (
                <CoverTile
                  selected={selected === "manual"}
                  current
                  imageUrl={manualCover.url}
                  title={fileNameOf(manualPath) || t("metadataEditor.manualCover")}
                  detail={candidateFolder(manualPath, fileNameOf(manualPath)) || t("metadataEditor.manualCover")}
                  path={manualPath}
                  onSelect={() => onSelect("manual")}
                />
              )}
              {candidates.map((candidate) => (
                <CoverTile
                  key={candidate.locationId}
                  selected={selected === candidate.locationId}
                  current={candidate.selected}
                  imageUrl={candidate.previewUrl}
                  title={candidate.fileName}
                  detail={candidateFolder(candidate.path, candidate.fileName) || formatBytes(candidate.sizeBytes)}
                  path={candidate.path}
                  onSelect={() => onSelect(candidate.locationId)}
                />
              ))}
            </div>
          )}
          {candidates.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              {t("libraryDetail.noIndexedLocalImages")}
            </p>
          )}
        </div>
      )}
    </MetadataEditorField>
  );
}
