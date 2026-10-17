import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, Package, Plus, Undo2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type WorkBundleCandidates, type WorkBundleMember } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { MetadataFieldStatusBadge } from "./MetadataEditorFields";
import { normalizedMetadataLinkCode } from "./metadataEditorModel";
import {
  bundleMemberRows,
  bundleMembersChanged,
  openBundleCandidates,
  stageBundleMemberAdd,
  stageBundleMemberRemove,
  unstageBundleMember,
  type StagedBundleMembers,
} from "./bundleMembersModel";

/**
 * The works an official bundle contains, by code. Each member stays its own
 * work; the bundle's detail lists them and theirs name the bundle. Works of
 * the bundle's DLsite series are offered as suggestions.
 */
export function MetadataEditorBundleSection({
  workId,
  primaryCode,
  members,
  staged,
  readOnly,
  onStage,
}: {
  workId: number;
  primaryCode: string;
  members: readonly WorkBundleMember[];
  staged: StagedBundleMembers;
  readOnly: boolean;
  onStage: (change: StagedBundleMembers) => void;
}) {
  const { t } = useTranslation();
  const copy = (key: string, options?: Record<string, unknown>) => t(`metadataEditor.bundle.${key}`, options);
  const [code, setCode] = useState("");
  const [suggestions, setSuggestions] = useState<WorkBundleCandidates | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(!readOnly);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    if (readOnly) return;
    const controller = new AbortController();
    setLoadingSuggestions(true);
    api.listWorkBundleCandidates(workId, controller.signal).then(
      (result) => {
        setSuggestions(result);
        setLoadingSuggestions(false);
      },
      () => {
        // Suggestions are optional; members can still be added by code.
        if (!controller.signal.aborted) setLoadingSuggestions(false);
      },
    );
    return () => controller.abort();
  }, [readOnly, workId]);

  const candidates = suggestions?.candidates ?? [];
  const rows = bundleMemberRows(members, staged, candidates);
  const open = openBundleCandidates(candidates, members, staged);
  const suggestionsVisible = open.length > 0 && (showSuggestions || Boolean(suggestions?.looksLikeBundle));
  const memberCode = normalizedMetadataLinkCode(code, primaryCode);
  const listed = rows.some((row) => row.code === memberCode && row.state !== "removed");
  const canAdd = Boolean(memberCode) && !listed;
  const add = (value: string) => onStage(stageBundleMemberAdd(staged, members, value));
  const addTyped = () => {
    if (!memberCode || !canAdd) return;
    add(memberCode);
    setCode("");
  };

  return (
    <section className="space-y-4 border-t pt-4" aria-labelledby="metadata-editor-bundle">
      <div className="space-y-1.5">
        <div className="flex min-h-7 items-center gap-2">
          <h3 id="metadata-editor-bundle" className="text-sm font-medium">
            {copy("title")}
          </h3>
          {bundleMembersChanged(staged) && <MetadataFieldStatusBadge status="edited" />}
        </div>
        <p className="text-xs text-muted-foreground">{copy("hint")}</p>
        {rows.length === 0 ? (
          <div className="flex min-h-11 items-center rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
            {copy("empty")}
          </div>
        ) : (
          <ul className="divide-y rounded-md border bg-card" aria-label={copy("title")}>
            {rows.map((row) => (
              <li key={row.code} className="flex min-h-11 items-center gap-2 px-3 py-2 text-sm">
                <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className={cn("min-w-0 flex-1", row.state === "removed" && "text-muted-foreground line-through")}>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs font-semibold">{row.code}</span>
                    <span className="min-w-0 truncate">{row.title || copy("notInLibrary")}</span>
                  </span>
                  {(row.state !== "kept" || row.origin === "detected") && (
                    <span className="block text-xs text-muted-foreground no-underline">
                      {row.state === "added"
                        ? copy("addPending")
                        : row.state === "removed"
                          ? copy("removePending")
                          : copy("detected")}
                    </span>
                  )}
                </span>
                {row.url && (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                    aria-label={t("libraryDetail.openMetadataLinkSource", { code: row.code })}
                    title={t("libraryDetail.openMetadataLinkSource", { code: row.code })}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
                {row.state === "kept" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 gap-1 px-2 text-muted-foreground"
                    aria-label={copy("removeNamed", { code: row.code })}
                    onClick={() => onStage(stageBundleMemberRemove(staged, row.code))}
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{copy("remove")}</span>
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 gap-1 px-2"
                    aria-label={copy("undoNamed", { code: row.code })}
                    onClick={() => onStage(unstageBundleMember(staged, row.code))}
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t("metadataEditor.undo")}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="metadata-editor-bundle-code" className="block text-sm font-medium">
          {copy("code")}
        </label>
        <div className="flex gap-2">
          <Input
            id="metadata-editor-bundle-code"
            fieldSize="sm"
            className="min-w-0 flex-1 font-mono uppercase"
            value={code}
            placeholder={t("libraryDetail.metadataLinkCodePlaceholder")}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={code.trim() !== "" && !memberCode}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              addTyped();
            }}
          />
          <Button variant="outline" size="sm" className="shrink-0" disabled={!canAdd} onClick={addTyped}>
            <Plus className="h-4 w-4" />
            {copy("add")}
          </Button>
        </div>
      </div>

      {!readOnly && (loadingSuggestions || open.length > 0) && (
        <div className="space-y-1.5">
          <div className="flex min-h-7 items-center justify-between gap-2">
            <h4 className="text-sm font-medium">{copy("suggestions")}</h4>
            {!suggestionsVisible && open.length > 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setShowSuggestions(true)}>
                {copy("showSuggestions", { count: open.length })}
              </Button>
            )}
          </div>
          {loadingSuggestions ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {copy("loadingSuggestions")}
            </div>
          ) : suggestionsVisible ? (
            <>
              <p className="text-xs text-muted-foreground">{copy("suggestionsHint")}</p>
              <ul className="divide-y rounded-md border" aria-label={copy("suggestions")}>
                {open.map((candidate) => (
                  <li key={candidate.code} className="flex min-h-11 items-center gap-2 px-3 py-2 text-sm">
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-xs font-semibold">{candidate.code}</span>
                      <span className="min-w-0 truncate text-muted-foreground">
                        {candidate.work?.title || copy("notInLibrary")}
                      </span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 gap-1 px-2"
                      aria-label={copy("addNamed", { code: candidate.code })}
                      onClick={() => add(candidate.code)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {copy("add")}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{copy("suggestionsHidden")}</p>
          )}
        </div>
      )}
    </section>
  );
}
