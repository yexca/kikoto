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
  visibleNavItems: readonly NavigationItem[];
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
};

export function commandActions({ hasPermission, visibleNavItems, onOpenPage, onOpenPath }: CommandActionContext) {
  const maintenanceActions: CommandAction[] = [
    ...(hasPermission("workflows:run") && hasPermission("metadata:sync")
      ? [
          {
            id: "action:local_scan",
            label: "Scan local library",
            description: "Scan local works and refresh local presence",
            icon: <ScanLine className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              await api.runLocalScan({ followUpRun: false });
              onOpenPath("/activity");
            },
          },
        ]
      : []),
    ...(hasPermission("metadata:sync")
      ? [
          {
            id: "action:dlsite_sync",
            label: "Run DLsite sync",
            description: "Queue metadata synchronization",
            icon: <Play className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              await api.runDLsiteSync();
              onOpenPath("/activity");
            },
          },
        ]
      : []),
    ...(hasPermission("workflows:run")
      ? [
          {
            id: "action:recover_stale",
            label: "Recover stale workflow runs",
            description: "Mark stale claimed jobs recoverable",
            icon: <RotateCcw className="h-4 w-4" />,
            closeOnRun: false,
            run: async () => {
              await api.recoverStaleWorkflowRuns();
              onOpenPath("/activity");
            },
          },
        ]
      : []),
  ];

  const activityActions: CommandAction[] = hasPermission("workflows:run")
    ? [
        {
          id: "activity:running",
          label: "Running runs",
          description: "Open current workflow activity",
          icon: <Activity className="h-4 w-4" />,
          run: () => onOpenPath("/activity"),
        },
        {
          id: "activity:review",
          label: "Review runs",
          description: "Open workflow runs needing review",
          icon: <ListChecks className="h-4 w-4" />,
          run: () => onOpenPath("/activity?view=review"),
        },
        {
          id: "activity:failed",
          label: "Failed runs",
          description: "Open failed workflow runs",
          icon: <Clock3 className="h-4 w-4" />,
          run: () => onOpenPath("/activity?view=failed"),
        },
      ]
    : [];

  return [
    ...maintenanceActions,
    ...visibleNavItems.map<CommandAction>((item) => ({
      id: `page:${item.id}`,
      label: item.label,
      description: item.path,
      icon: <item.icon className="h-4 w-4" />,
      run: () => onOpenPage(item.id),
    })),
    ...activityActions,
  ];
}
