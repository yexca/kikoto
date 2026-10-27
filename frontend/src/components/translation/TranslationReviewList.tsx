import { ArrowRight, Check, FileText, Loader2, RotateCw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TranslationItem } from "@/lib/translationApi";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { cn } from "@/lib/tailwindClassNames";
import {
  acceptableIds,
  groupTranslationItems,
  hasInlineText,
  translationFailureKey,
  translationStateBadges,
  type TranslationReviewGroup,
} from "./translationReviewModel";

export type TranslationReviewMode = "review" | "active" | "attention" | "history";

/**
 * Translation items grouped by work, language and category. In review mode
 * each item, group and language can be accepted or discarded; in attention
 * mode stopped items can be sent again or dismissed. Lyrics are previewed as
 * files through `renderLyricsPreview`.
 */
export function TranslationReviewList({
  items,
  mode,
  showWork = false,
  busyIds = new Set<number>(),
  readOnly = false,
  onAccept,
  onReject,
  onResend,
  renderLyricsPreview,
  renderWorkLink,
}: {
  items: readonly TranslationItem[];
  mode: TranslationReviewMode;
  /** Heads each work's items with its code and title, for lists across works. */
  showWork?: boolean;
  busyIds?: ReadonlySet<number>;
  readOnly?: boolean;
  onAccept?: (ids: number[]) => void;
  onReject?: (ids: number[]) => void;
  onResend?: (ids: number[], acknowledgeUncertain: boolean) => void;
  renderLyricsPreview?: (item: TranslationItem) => ReactNode;
  renderWorkLink?: (workCode: string, label: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const sections = groupTranslationItems(items);
  const languageName = (language: string) =>
    t(metadataTagNameLanguages.find(([value]) => value === language)?.[1] ?? language);
  const groupLabel = (group: TranslationReviewGroup) => t(`translationReview.groups.${group}`);
  const busy = (ids: number[]) => ids.some((id) => busyIds.has(id));
  return (
    <div className="space-y-4">
      {sections.map((work) => (
        <section
          key={work.workId}
          aria-label={showWork ? `${work.workCode} ${work.workTitle}` : undefined}
          className="space-y-3"
        >
          {showWork && (
            <h3 className="flex min-w-0 items-baseline gap-2 text-sm font-medium">
              {renderWorkLink ? (
                renderWorkLink(work.workCode, <span className="font-mono text-xs">{work.workCode}</span>)
              ) : (
                <span className="font-mono text-xs text-muted-foreground">{work.workCode}</span>
              )}
              <span className="min-w-0 truncate" title={work.workTitle}>
                {work.workTitle}
              </span>
            </h3>
          )}
          {work.languages.map((language) => {
            const ready = acceptableIds(language.groups.flatMap((group) => group.items));
            return (
              <div key={language.language} className="overflow-hidden rounded-lg border bg-card">
                <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-1.5 sm:px-4">
                  <h4 className="text-sm font-medium">{languageName(language.language)}</h4>
                  {mode === "review" && !readOnly && onAccept && ready.length > 1 && (
                    <Button size="sm" variant="outline" disabled={busy(ready)} onClick={() => onAccept(ready)}>
                      <Check className="h-4 w-4" />
                      {t("translationReview.acceptAll", { count: ready.length })}
                    </Button>
                  )}
                </div>
                <div className="divide-y">
                  {language.groups.map((group) => {
                    const groupReady = acceptableIds(group.items);
                    const affected = group.items.find((item) => item.affectedWorks)?.affectedWorks;
                    return (
                      <div key={group.group} className="px-3 py-2 sm:px-4">
                        <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
                          <h5 className="text-xs font-medium text-muted-foreground">
                            {groupLabel(group.group)}
                            {group.group === "tags" && affected ? (
                              <span className="ml-2 font-normal">
                                {t("translationReview.sharedTagsAffect", { count: affected })}
                              </span>
                            ) : null}
                          </h5>
                          {mode === "review" && !readOnly && onAccept && groupReady.length > 1 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy(groupReady)}
                              onClick={() => onAccept(groupReady)}
                            >
                              <Check className="h-4 w-4" />
                              {t("translationReview.acceptGroup", { count: groupReady.length })}
                            </Button>
                          )}
                        </div>
                        <ul className="space-y-2 pb-1">
                          {group.items.map((item) => (
                            <TranslationReviewRow
                              key={item.id}
                              item={item}
                              mode={mode}
                              busy={busyIds.has(item.id)}
                              readOnly={readOnly}
                              onAccept={onAccept}
                              onReject={onReject}
                              onResend={onResend}
                              renderLyricsPreview={renderLyricsPreview}
                            />
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function TranslationReviewRow({
  item,
  mode,
  busy,
  readOnly,
  onAccept,
  onReject,
  onResend,
  renderLyricsPreview,
}: {
  item: TranslationItem;
  mode: TranslationReviewMode;
  busy: boolean;
  readOnly: boolean;
  onAccept?: (ids: number[]) => void;
  onReject?: (ids: number[]) => void;
  onResend?: (ids: number[], acknowledgeUncertain: boolean) => void;
  renderLyricsPreview?: (item: TranslationItem) => ReactNode;
}) {
  const { t } = useTranslation();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmingResend, setConfirmingResend] = useState(false);
  const lyrics = item.category === "lyrics";
  const label = lyrics || item.category === "file_name" || item.category === "folder_name" ? item.label : "";
  const stopped = ["failed", "uncertain", "invalid", "policy_blocked"].includes(item.state);
  return (
    <li className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-60 space-y-1">
          {label && (
            <div className="truncate text-sm font-medium" title={label}>
              {label}
            </div>
          )}
          {hasInlineText(item) ? (
            <div className="grid min-w-0 gap-1 text-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start sm:gap-2">
              <div className="min-w-0 whitespace-pre-wrap break-words text-muted-foreground">{item.source || "—"}</div>
              <ArrowRight
                className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:mt-0.5 sm:block"
                aria-hidden="true"
              />
              <div className="min-w-0 whitespace-pre-wrap break-words">
                {item.result || <span className="text-muted-foreground">—</span>}
              </div>
            </div>
          ) : (
            <LyricsItemNote item={item} />
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {item.state !== "ready" && (
              <Badge variant={translationStateBadges[item.state]} className="px-1.5 py-0 text-2xs">
                {item.state === "requesting" && <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />}
                {t(`translationReview.states.${item.state}`)}
              </Badge>
            )}
            {lyrics && item.chunks > 1 && mode === "active" && (
              <span className="tabular-nums">
                {t("translationReview.chunks", { done: item.progress, total: item.chunks })}
              </span>
            )}
            <span>{t("translationReview.byLLM", { model: item.model })}</span>
            {item.requestedBy && <span>· {t("translationReview.requestedBy", { name: item.requestedBy })}</span>}
          </div>
          {stopped && (
            <p className={cn("text-xs", item.state === "invalid" ? "text-muted-foreground" : "text-error-foreground")}>
              {t(translationFailureKey(item.failureCode))}
            </p>
          )}
        </div>
        {!readOnly && (
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {lyrics && renderLyricsPreview && item.state === "ready" && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={previewOpen}
                aria-label={t("translationReview.previewOf", { title: item.label })}
                onClick={() => setPreviewOpen((current) => !current)}
              >
                <FileText className="h-4 w-4" />
                {t("translationReview.preview")}
              </Button>
            )}
            {mode === "review" && item.state === "ready" && (
              <>
                {onReject && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReject([item.id])}>
                    <Trash2 className="h-4 w-4" />
                    {t("translationReview.discard")}
                  </Button>
                )}
                {onAccept && (
                  <Button size="sm" disabled={busy} onClick={() => onAccept([item.id])}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {lyrics ? t("translationReview.acceptLyrics") : t("translationReview.accept")}
                  </Button>
                )}
              </>
            )}
            {mode === "attention" && stopped && (
              <>
                {onReject && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReject([item.id])}>
                    {t("translationReview.dismiss")}
                  </Button>
                )}
                {onResend && (item.state === "failed" || item.state === "uncertain") && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (item.state === "uncertain" && !confirmingResend) {
                        setConfirmingResend(true);
                        return;
                      }
                      setConfirmingResend(false);
                      onResend([item.id], item.state === "uncertain");
                    }}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                    {confirmingResend ? t("translationReview.resendAnyway") : t("translationReview.resend")}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {confirmingResend && (
        <p className="text-xs text-warning-foreground" role="status">
          {t("translationReview.uncertainHint")}
        </p>
      )}
      {previewOpen && renderLyricsPreview?.(item)}
    </li>
  );
}

/** What a lyrics item reads, or the file it became. */
function LyricsItemNote({ item }: { item: TranslationItem }) {
  const { t } = useTranslation();
  let note: string;
  if (item.appliedPath) {
    note = t("translationReview.appliedTo", { path: item.appliedPath });
  } else {
    note = t("translationReview.fromFile", { file: item.sourceTitle || "—" });
  }
  return <p className="text-xs text-muted-foreground">{note}</p>;
}
