import { CheckCheck, ListChecks, Pencil, Sparkles, Zap } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { FavoriteList, SmartRuleTagView } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { smartRuleSummary } from "./smartListModel";

/**
 * The smart list strip under the shelf header: what the rule matches, the new
 * works it found, and turning the list into a regular one.
 */
export function SmartListPanel({
  list,
  newCount,
  newOnly,
  workCount,
  canEdit,
  onToggleNewOnly,
  onMarkSeen,
  onEditRule,
  onConvert,
}: {
  list: FavoriteList;
  newCount: number;
  newOnly: boolean;
  /** Works the list shows now, which a conversion keeps. */
  workCount: number;
  canEdit: boolean;
  onToggleNewOnly: () => void;
  onMarkSeen: () => Promise<void>;
  onEditRule: () => void;
  onConvert: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"" | "seen" | "convert">("");
  const [confirmingConvert, setConfirmingConvert] = useState(false);
  const rule = list.rule;
  const summary = rule ? smartRuleSummary(rule) : { require: [], any: [], hidden: 0 };
  const run = async (action: "seen" | "convert", task: () => Promise<void>) => {
    setBusy(action);
    try {
      await task();
      if (action === "convert") setConfirmingConvert(false);
    } finally {
      setBusy("");
    }
  };

  return (
    <section
      aria-label={t("favorites.smart.ruleLabel")}
      className="grid gap-2 rounded-[var(--radius)] border bg-card/60 px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Zap className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {summary.require.length > 0 && <RuleSummaryLabel>{t("favorites.smart.summaryAll")}</RuleSummaryLabel>}
          {summary.require.map((tag) => (
            <RuleSummaryChip key={`${tag.kind}:${tag.id}`} tag={tag} />
          ))}
          {summary.any.length > 0 && (
            <RuleSummaryLabel>
              {summary.require.length > 0 ? t("favorites.smart.summaryAnyAfter") : t("favorites.smart.summaryAny")}
            </RuleSummaryLabel>
          )}
          {summary.any.map((tag) => (
            <RuleSummaryChip key={`${tag.kind}:${tag.id}`} tag={tag} />
          ))}
          {summary.hidden > 0 && (
            <li className="text-xs text-muted-foreground">
              {t("favorites.smart.moreTags", { count: summary.hidden })}
            </li>
          )}
          {rule?.exclude.map((tag) => (
            <RuleSummaryChip key={`${tag.kind}:${tag.id}`} tag={tag} excluded />
          ))}
        </ul>
        {canEdit && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onEditRule}>
              <Pencil className="h-3.5 w-3.5" />
              {t("favorites.smart.editRule")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => setConfirmingConvert(true)}
              disabled={busy !== ""}
            >
              <ListChecks className="h-3.5 w-3.5" />
              {t("favorites.smart.convert")}
            </Button>
          </div>
        )}
      </div>
      {(newCount > 0 || newOnly) && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-sm" role="status">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="font-medium">{t("favorites.smart.newCount", { count: newCount })}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant={newOnly ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2 text-xs"
              aria-pressed={newOnly}
              onClick={onToggleNewOnly}
            >
              {t("favorites.smart.showNewOnly")}
            </Button>
            {canEdit && newCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                disabled={busy !== ""}
                onClick={() => void run("seen", onMarkSeen)}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                {t("favorites.smart.markSeen")}
              </Button>
            )}
          </div>
        </div>
      )}
      {confirmingConvert && (
        <Dialog
          size="sm"
          role="alertdialog"
          onClose={() => busy === "" && setConfirmingConvert(false)}
          dismissible={busy === ""}
        >
          <DialogHeader
            title={t("favorites.smart.convertTitle")}
            description={t("favorites.smart.convertDescription", { count: workCount, name: list.name })}
          />
          <DialogBody className="text-sm text-muted-foreground">{t("favorites.smart.convertDetail")}</DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingConvert(false)} disabled={busy !== ""}>
              {t("content.cancel")}
            </Button>
            <Button size="sm" onClick={() => void run("convert", onConvert)} disabled={busy !== ""} autoFocus>
              {busy === "convert" ? t("favorites.smart.converting") : t("favorites.smart.convert")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </section>
  );
}

function RuleSummaryLabel({ children }: { children: string }) {
  return <li className="text-xs font-medium text-muted-foreground">{children}</li>;
}

function RuleSummaryChip({ tag, excluded = false }: { tag: SmartRuleTagView; excluded?: boolean }) {
  const { t } = useTranslation();
  const unusable = tag.state === "hidden" || tag.state === "missing";
  const name = tag.name || t("favorites.smart.unknownTag");
  return (
    <li
      className={cn(
        "inline-flex h-6 max-w-[14rem] items-center gap-1 rounded-full border px-2 text-xs",
        excluded ? "bg-muted/60 text-muted-foreground" : "bg-background",
        unusable && "border-dashed text-muted-foreground line-through",
      )}
      title={
        tag.state === "hidden"
          ? t("favorites.smart.stateHidden")
          : tag.state === "missing"
            ? t("favorites.smart.stateMissing")
            : undefined
      }
    >
      {excluded && <span className="sr-only">{t("favorites.smart.excludedTag")}</span>}
      {excluded && <span aria-hidden="true">−</span>}
      <span className="truncate">{name}</span>
    </li>
  );
}
