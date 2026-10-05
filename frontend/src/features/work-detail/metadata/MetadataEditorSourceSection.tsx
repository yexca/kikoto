import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Link2, Undo2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkMetadataLink } from "@/lib/api";
import { MetadataFieldStatusBadge } from "./MetadataEditorFields";
import { normalizedMetadataLinkCode } from "./metadataEditorModel";

/** A metadata link change waiting for Save: link to another code, or remove the link. */
export type StagedMetadataLink = { action: "link"; code: string } | { action: "unlink" } | null;

export function MetadataEditorSourceSection({
  link,
  primaryCode,
  staged,
  onStage,
}: {
  link?: WorkMetadataLink | null;
  primaryCode: string;
  staged: StagedMetadataLink;
  onStage: (change: StagedMetadataLink) => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const sourceCode = normalizedMetadataLinkCode(code, primaryCode);
  const canLink = Boolean(sourceCode) && sourceCode !== link?.sourceCode;
  const stageLink = () => {
    if (!sourceCode || !canLink) return;
    onStage({ action: "link", code: sourceCode });
    setCode("");
  };
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex min-h-7 items-center gap-2">
          <span className="text-sm font-medium">{t("metadataEditor.currentSource")}</span>
          {staged && <MetadataFieldStatusBadge status="edited" />}
        </div>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm">
          {staged?.action === "link" ? (
            <span className="min-w-0">{t("metadataEditor.linkPending", { code: staged.code })}</span>
          ) : staged?.action === "unlink" ? (
            <span className="min-w-0">{t("metadataEditor.unlinkPending", { code: link?.sourceCode ?? "" })}</span>
          ) : link ? (
            <span className="inline-flex min-w-0 items-center gap-2">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{t("libraryDetail.metadataLinkCurrent", { code: link.sourceCode })}</span>
              {link.url && (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                  aria-label={t("libraryDetail.openMetadataLinkSource", { code: link.sourceCode })}
                  title={t("libraryDetail.openMetadataLinkSource", { code: link.sourceCode })}
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </span>
          ) : (
            <span className="min-w-0 text-muted-foreground">
              {t("metadataEditor.ownMetadata", { code: primaryCode })}
            </span>
          )}
          {staged ? (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => onStage(null)}>
              <Undo2 className="h-3.5 w-3.5" />
              {t("metadataEditor.undo")}
            </Button>
          ) : (
            link && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-muted-foreground"
                onClick={() => onStage({ action: "unlink" })}
              >
                <Unlink className="h-3.5 w-3.5" />
                {t("libraryDetail.removeMetadataLink")}
              </Button>
            )
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="metadata-editor-link-code" className="block text-sm font-medium">
          {t("libraryDetail.metadataLinkCode")}
        </label>
        <div className="flex gap-2">
          <Input
            id="metadata-editor-link-code"
            fieldSize="sm"
            className="min-w-0 flex-1 font-mono uppercase"
            value={code}
            placeholder={t("libraryDetail.metadataLinkCodePlaceholder")}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={code.trim() !== "" && !sourceCode}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              stageLink();
            }}
          />
          <Button variant="outline" size="sm" className="shrink-0" disabled={!canLink} onClick={stageLink}>
            <Link2 className="h-4 w-4" />
            {t("libraryDetail.linkMetadata")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("metadataEditor.linkHint")}</p>
      </div>
    </div>
  );
}
