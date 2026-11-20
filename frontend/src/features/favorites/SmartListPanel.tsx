import { CheckCheck, Pencil, Sparkles, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { FavoriteList, SmartRuleTagView } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { smartRuleSummary } from "./smartListModel";

/**
 * The smart list line under the shelf header: what the rule matches, then a
 * new-works chip that toggles Only new, and icon actions for Mark all as seen
 * and Edit rule. Converting the list to a regular one waits in its editor.
 */
export function SmartListPanel({
  list,
  newCount,
  newOnly,
  canEdit,
  onToggleNewOnly,
  onMarkSeen,
  onEditRule,
}: {
  list: FavoriteList;
  newCount: number;
  newOnly: boolean;
  canEdit: boolean;
  onToggleNewOnly: () => void;
  onMarkSeen: () => Promise<void>;
  onEditRule: () => void;
}) {
  const { t } = useTranslation();
  const [markingSeen, setMarkingSeen] = useState(false);
  const rule = list.rule;
  const summary = rule ? smartRuleSummary(rule) : { require: [], any: [], hidden: 0 };
  const markSeen = async () => {
    setMarkingSeen(true);
    try {
      await onMarkSeen();
    } finally {
      setMarkingSeen(false);
    }
  };

  return (
    <section
      aria-label={t("favorites.smart.ruleLabel")}
      className="flex items-center gap-2 rounded-[var(--radius)] border bg-card/60 py-1 pl-3 pr-1"
    >
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
          <li className="text-xs text-muted-foreground">{t("favorites.smart.moreTags", { count: summary.hidden })}</li>
        )}
        {rule?.exclude.map((tag) => (
          <RuleSummaryChip key={`${tag.kind}:${tag.id}`} tag={tag} excluded />
        ))}
      </ul>
      <div className="ml-auto flex items-center gap-0.5">
        {(newCount > 0 || newOnly) && (
          // The new count is the Only new toggle itself, so the line holds one chip instead of a label and a button.
          <button
            type="button"
            aria-pressed={newOnly}
            title={t("favorites.smart.showNewOnly")}
            onClick={onToggleNewOnly}
            className={cn(
              "touch-target inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              newOnly
                ? "border-primary bg-primary text-primary-foreground"
                : "border-primary/40 text-primary hover:bg-primary/10",
            )}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="whitespace-nowrap">{t("favorites.smart.newCount", { count: newCount })}</span>
          </button>
        )}
        {canEdit && newCount > 0 && (
          <PanelIconButton label={t("favorites.smart.markSeen")} disabled={markingSeen} onClick={() => void markSeen()}>
            <CheckCheck className="h-4 w-4" />
          </PanelIconButton>
        )}
        {canEdit && (
          <PanelIconButton label={t("favorites.smart.editRule")} onClick={onEditRule}>
            <Pencil className="h-4 w-4" />
          </PanelIconButton>
        )}
      </div>
    </section>
  );
}

function PanelIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0 text-muted-foreground"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
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
