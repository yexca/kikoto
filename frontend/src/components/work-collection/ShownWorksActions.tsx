import { DatabaseZap, Loader2, SearchCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import type { ShownWorksAction, ShownWorksActions } from "@/hooks/useShownWorksActions";
import type { ShownWorksActionResult } from "@/lib/api";

/**
 * The menu of actions on the shown works. An action without a request is one
 * the account may not run, or the view does not offer, and the menu leaves it
 * out; with no action left, the button stays in place, disabled.
 */
export function ShownWorksActionMenu({
  actions,
  requests,
}: {
  actions: ShownWorksActions;
  requests: Partial<Record<ShownWorksAction, () => Promise<ShownWorksActionResult>>>;
}) {
  const { t } = useTranslation();
  const item = (action: ShownWorksAction, icon: ActionMenuItem["icon"]): ActionMenuItem[] => {
    const request = requests[action];
    if (!request) return [];
    return [
      {
        key: action,
        label: t(`subscriptions.actions.${action}.label`),
        hint: t(`subscriptions.actions.${action}.hint`),
        icon,
        disabled: Boolean(actions[action]) || actions.submitting === action,
        onSelect: () => actions.run(action, request),
      },
    ];
  };
  return (
    <ActionMenu
      label={t("subscriptions.actions.label")}
      buttonLabel={t("subscriptions.actions.button")}
      keepWhenEmpty
      toolbar
      items={[
        ...item("metadata", <DatabaseZap className="h-4 w-4" />),
        ...item("sources", <SearchCheck className="h-4 w-4" />),
      ]}
    />
  );
}

/** Follows the running actions, each with a link to its run. */
export function ShownWorksActionStatus({
  actions,
  onOpenRun,
}: {
  actions: ShownWorksActions;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const running = (["metadata", "sources"] as const).flatMap((action) => {
    const run = actions[action];
    return run ? [{ action, run }] : [];
  });
  if (running.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-info-border bg-info-surface px-3 py-1.5 text-xs text-info-foreground"
      role="status"
    >
      {running.map(({ action, run }) => (
        <span key={action} className="flex min-w-0 items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className="min-w-0">{t(`subscriptions.actions.${action}.running`, { count: run.queued })}</span>
          <button
            type="button"
            className="shrink-0 rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpenRun(run.runId)}
          >
            {t("subscriptions.actions.viewRun")}
          </button>
        </span>
      ))}
    </div>
  );
}
