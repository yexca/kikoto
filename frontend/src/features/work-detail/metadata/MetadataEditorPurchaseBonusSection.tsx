import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Gift, Undo2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkPurchaseBonus } from "@/lib/api";
import { MetadataFieldStatusBadge } from "./MetadataEditorFields";
import { normalizedMetadataLinkCode } from "./metadataEditorModel";

/** A purchase bonus change waiting for Save: link to a parent code, or remove the link. */
export type StagedPurchaseBonus = { action: "link"; code: string } | { action: "unlink" } | null;

export function MetadataEditorPurchaseBonusSection({
  bonus,
  primaryCode,
  staged,
  onStage,
}: {
  bonus?: WorkPurchaseBonus | null;
  primaryCode: string;
  staged: StagedPurchaseBonus;
  onStage: (change: StagedPurchaseBonus) => void;
}) {
  const { t } = useTranslation();
  const bonusCopy = (key: string, options?: Record<string, unknown>) =>
    t(`metadataEditor.purchaseBonus.${key}`, options);
  const [code, setCode] = useState("");
  const linked = bonus?.status === "linked" && bonus.parentCode ? bonus : null;
  const parentCode = normalizedMetadataLinkCode(code, primaryCode);
  const canLink = Boolean(parentCode) && parentCode !== linked?.parentCode;
  const stageLink = () => {
    if (!parentCode || !canLink) return;
    onStage({ action: "link", code: parentCode });
    setCode("");
  };
  return (
    <section className="space-y-4 border-t pt-4" aria-labelledby="metadata-editor-purchase-bonus">
      <div className="space-y-1.5">
        <div className="flex min-h-7 items-center gap-2">
          <h3 id="metadata-editor-purchase-bonus" className="text-sm font-medium">
            {bonusCopy("title")}
          </h3>
          {staged && <MetadataFieldStatusBadge status="edited" />}
        </div>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm">
          {staged?.action === "link" ? (
            <span className="min-w-0">{bonusCopy("linkPending", { code: staged.code })}</span>
          ) : staged?.action === "unlink" ? (
            <span className="min-w-0">{bonusCopy("unlinkPending", { code: linked?.parentCode ?? "" })}</span>
          ) : linked ? (
            <span className="inline-flex min-w-0 items-center gap-2">
              <Gift className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {linked.parentWork?.title
                  ? bonusCopy("linkedTitle", { title: linked.parentWork.title, code: linked.parentCode })
                  : bonusCopy("linked", { code: linked.parentCode })}
              </span>
              {linked.origin === "detected" && (
                <span className="shrink-0 text-xs text-muted-foreground">{bonusCopy("detected")}</span>
              )}
              {linked.url && (
                <a
                  href={linked.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                  aria-label={t("libraryDetail.openMetadataLinkSource", { code: linked.parentCode })}
                  title={t("libraryDetail.openMetadataLinkSource", { code: linked.parentCode })}
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </span>
          ) : (
            <span className="min-w-0 text-muted-foreground">
              {bonusCopy(
                bonus?.status === "dismissed" ? "dismissed" : bonus?.status === "unmatched" ? "unmatched" : "none",
              )}
            </span>
          )}
          {staged ? (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => onStage(null)}>
              <Undo2 className="h-3.5 w-3.5" />
              {t("metadataEditor.undo")}
            </Button>
          ) : (
            linked && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-muted-foreground"
                onClick={() => onStage({ action: "unlink" })}
              >
                <Unlink className="h-3.5 w-3.5" />
                {bonusCopy("remove")}
              </Button>
            )
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="metadata-editor-purchase-bonus-code" className="block text-sm font-medium">
          {bonusCopy("code")}
        </label>
        <div className="flex gap-2">
          <Input
            id="metadata-editor-purchase-bonus-code"
            fieldSize="sm"
            className="min-w-0 flex-1 font-mono uppercase"
            value={code}
            placeholder={t("libraryDetail.metadataLinkCodePlaceholder")}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={code.trim() !== "" && !parentCode}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              stageLink();
            }}
          />
          <Button variant="outline" size="sm" className="shrink-0" disabled={!canLink} onClick={stageLink}>
            <Gift className="h-4 w-4" />
            {bonusCopy("link")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{bonusCopy("hint")}</p>
      </div>
    </section>
  );
}
