import { Activity, Clock3, ListChecks, Play, RotateCcw, ScanLine } from "lucide-react";

import { type NavigationItem, type PageID } from "@/app/navigation";
import { api } from "@/lib/api";

export type CommandAction = {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  run: () => void | Promise<void>;
  closeOnRun?: boolean;
};

type CommandActionContext = {
  hasPermission: (permission: string) => boolean;
  /** Read-only view permission; Demo can open surfaces it cannot change. Defaults to hasPermission. */
  canView?: (permission: string) => boolean;
  visibleNavItems: readonly NavigationItem[];
  translate?: (key: string) => string;
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
};

export function commandActions({
  hasPermission,
  canView = hasPermission,
  visibleNavItems,
  translate,
  onOpenPage,
  onOpenPath,
}: CommandActionContext) {
  const text = (key: string, fallback: string) => {
    const translated = translate?.(key);
    return !translated || translated === key ? fallback : translated;
  };
  const maintenanceActions: CommandAction[] = [
    ...(hasPermission("workflows:run") && hasPermission("metadata:sync")
      ? [
          {
            id: "action:local_scan",
            label: text("commands.scanLocalLibrary", "Scan local library"),
            description: text("commands.scanLocalLibraryDescription", "Scan local works and refresh local presence"),
            icon: <ScanLine className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              const result = await api.runLocalScan({ followUpRun: false });
              onOpenPath(`/workflows?activity=1&workflow=local_library_scan&run=${result.runId}`);
            },
          },
        ]
      : []),
    ...(hasPermission("metadata:sync")
      ? [
          {
            id: "action:dlsite_sync",
            label: text("commands.runDLsiteSync", "Run DLsite sync"),
            description: text("commands.runDLsiteSyncDescription", "Queue metadata synchronization"),
            icon: <Play className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              const result = await api.runDLsiteSync();
              onOpenPath(`/workflows?activity=1&workflow=metadata_sync&run=${result.runId}`);
            },
          },
        ]
      : []),
    ...(hasPermission("workflows:run")
      ? [
          {
            id: "action:recover_stale",
            label: text("commands.recoverStaleRuns", "Recover stale workflow runs"),
            description: text("commands.recoverStaleRunsDescription", "Requeue or fail jobs no executor is running"),
            icon: <RotateCcw className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              await api.recoverStaleWorkflowRuns();
              onOpenPath("/workflows?activity=1");
            },
          },
        ]
      : []),
  ];

  const activityActions: CommandAction[] = canView("workflows:run")
    ? [
        {
          id: "activity:running",
          label: text("commands.runningRuns", "Running runs"),
          description: text("commands.runningRunsDescription", "Open current workflow activity"),
          icon: <Activity className="h-4 w-4" />,
          run: () => onOpenPath("/workflows?activity=1"),
        },
        {
          id: "activity:review",
          label: text("commands.reviewRuns", "Review runs"),
          description: text("commands.reviewRunsDescription", "Open workflow runs needing review"),
          icon: <ListChecks className="h-4 w-4" />,
          run: () => onOpenPath("/workflows?activity=1&view=review"),
        },
        {
          id: "activity:failed",
          label: text("commands.failedRuns", "Failed runs"),
          description: text("commands.failedRunsDescription", "Open failed workflow runs"),
          icon: <Clock3 className="h-4 w-4" />,
          run: () => onOpenPath("/workflows?activity=1&view=failed"),
        },
      ]
    : [];

  return [
    ...maintenanceActions,
    ...visibleNavItems.map<CommandAction>((item) => ({
      id: `page:${item.id}`,
      label: text(item.labelKey, item.label),
      description: item.path,
      icon: <item.icon className="h-4 w-4" />,
      run: () => onOpenPage(item.id),
    })),
    ...activityActions,
  ];
}
