import { ArchiveRestore, Clock3, Play, RotateCcw, ScanLine, TriangleAlert } from "lucide-react";

import { type NavigationItem, type PageID } from "@/app/navigation";
import { workflowRunPath, workflowsPath } from "@/features/workflows/workflowLinks";
import { api } from "@/lib/api";
import { PERSONAL_DATA_PERMISSION, YOUR_DATA_SETTINGS_PATH } from "@/pages/settingsPaths";

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
  /**
   * Read-only view permission; Demo can open surfaces it cannot change and
   * lists the maintenance commands, which the server refuses. Defaults to hasPermission.
   */
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
    ...(canView("workflows:run") && canView("metadata:sync")
      ? [
          {
            id: "action:local_scan",
            label: text("commands.scanLocalLibrary", "Scan local library"),
            description: text("commands.scanLocalLibraryDescription", "Scan local works and refresh local presence"),
            icon: <ScanLine className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              const result = await api.runLocalScan({ followUpRun: false });
              onOpenPath(workflowRunPath(result.runId));
            },
          },
        ]
      : []),
    ...(canView("metadata:sync")
      ? [
          {
            id: "action:dlsite_sync",
            label: text("commands.runDLsiteSync", "Run DLsite sync"),
            description: text("commands.runDLsiteSyncDescription", "Queue metadata synchronization"),
            icon: <Play className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              const result = await api.runDLsiteSync();
              onOpenPath(workflowRunPath(result.runId));
            },
          },
        ]
      : []),
    // Recovering stale runs is workflow maintenance, kept with the other
    // instance maintenance under sources:write.
    ...(canView("workflows:run") && canView("sources:write")
      ? [
          {
            id: "action:recover_stale",
            label: text("commands.recoverStaleRuns", "Recover stale workflow runs"),
            description: text("commands.recoverStaleRunsDescription", "Requeue or fail jobs no executor is running"),
            icon: <RotateCcw className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              await api.recoverStaleWorkflowRuns();
              onOpenPath(workflowsPath());
            },
          },
        ]
      : []),
  ];

  const activityActions: CommandAction[] = canView("workflows:run")
    ? [
        {
          id: "activity:attention",
          label: text("commands.activityAttention", "Runs needing attention"),
          description: text("commands.activityAttentionDescription", "Failed runs and items waiting for review"),
          icon: <TriangleAlert className="h-4 w-4" />,
          run: () => onOpenPath(workflowsPath({ tab: "attention" })),
        },
        {
          id: "activity:history",
          label: text("commands.activityHistory", "Workflow history"),
          description: text("commands.activityHistoryDescription", "Finished and acknowledged workflow runs"),
          icon: <Clock3 className="h-4 w-4" />,
          run: () => onOpenPath(workflowsPath({ tab: "history" })),
        },
      ]
    : [];

  return [
    ...maintenanceActions,
    ...visibleNavItems.flatMap<CommandAction>((item) => [
      {
        id: `page:${item.id}`,
        label: text(item.labelKey, item.label),
        description: item.path,
        icon: <item.icon className="h-4 w-4" />,
        run: () => onOpenPage(item.id),
      },
      // Your data is a section of Settings and stays a direct Quick actions destination.
      ...(item.id === "settings" && canView(PERSONAL_DATA_PERMISSION)
        ? [
            {
              id: "settings:data",
              label: text("nav.userData", "Your data"),
              description: YOUR_DATA_SETTINGS_PATH,
              icon: <ArchiveRestore className="h-4 w-4" />,
              run: () => onOpenPath(YOUR_DATA_SETTINGS_PATH),
            },
          ]
        : []),
    ]),
    ...activityActions,
  ];
}
