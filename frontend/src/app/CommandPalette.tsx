import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, FileAudio, Loader2, Search, Workflow, X } from "lucide-react";

import { commandActions, type CommandAction } from "@/app/commandActions";
import { type NavigationItem, type PageID } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { parseWorkflowDefinition } from "@/features/workflows/definitionModel";
import { WorkflowRunDialog } from "@/features/workflows/WorkflowRunDialog";
import {
  parseWorkflowCommand,
  publishedWorkflowCommandsForUser,
  workflowCommandInputValues,
  workflowCommandUsage,
} from "@/features/workflows/workflowCommands";
import { api, type WorkflowDefinition } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isWorkCode } from "@/lib/workCode";

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasPermission: (permission: string) => boolean;
  visibleNavItems: readonly NavigationItem[];
  currentUserId: number | null;
  onBusyChange?: (busy: boolean) => void;
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
};

type PaletteAction = CommandAction & {
  disabled?: boolean;
};

export function CommandPalette({
  open,
  onOpenChange,
  hasPermission,
  visibleNavItems,
  currentUserId,
  onBusyChange,
  onOpenPage,
  onOpenPath,
}: CommandPaletteProps) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [workflowLaunch, setWorkflowLaunch] = useState<{
    definition: WorkflowDefinition;
    inputs: Record<string, unknown>;
  } | null>(null);
  const [workflowLaunchBusy, setWorkflowLaunchBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseActions = useMemo<PaletteAction[]>(
    () => commandActions({ hasPermission, visibleNavItems, onOpenPage, onOpenPath }),
    [hasPermission, visibleNavItems, onOpenPage, onOpenPath],
  );
  const workflowCommands = useMemo(
    () => publishedWorkflowCommandsForUser(definitions, currentUserId),
    [currentUserId, definitions],
  );
  const cleanQuery = query.trim();
  const parsedCommand = useMemo(() => parseWorkflowCommand(query), [query]);
  const codeMatch = isWorkCode(cleanQuery);
  const handleWorkflowBusyChange = useCallback(
    (nextBusy: boolean) => {
      setWorkflowLaunchBusy(nextBusy);
      onBusyChange?.(nextBusy);
    },
    [onBusyChange],
  );

  const actions = useMemo<PaletteAction[]>(() => {
    if (parsedCommand.isCommand) {
      const matching = workflowCommands.filter(
        (command) => !parsedCommand.alias || command.alias.toLowerCase().startsWith(parsedCommand.alias.toLowerCase()),
      );
      const exact = matching.filter((command) => command.alias.toLowerCase() === parsedCommand.alias.toLowerCase());
      if (exact.length > 0) {
        return exact.map((command) => {
          const parsedValues = workflowCommandInputValues(parsedCommand.arguments, command.document.inputs);
          const errors = [parsedCommand.error, ...parsedValues.errors].filter(Boolean);
          const launchMode = command.document.policy.requirePreview
            ? "Preview required"
            : "Preview, then run within saved limits";
          return {
            id: `workflow:${command.definition.id}`,
            label: `${command.document.policy.requirePreview ? "Preview" : "Run"} ${command.definition.displayName}`,
            description:
              errors.length > 0
                ? errors.join(" ")
                : `${launchMode} · ${workflowCommandUsage(command.alias, command.document.inputs)}`,
            icon: errors.length > 0 ? <Workflow className="h-4 w-4 opacity-50" /> : <Workflow className="h-4 w-4" />,
            disabled: errors.length > 0,
            closeOnRun: false,
            run: () => setWorkflowLaunch({ definition: command.definition, inputs: parsedValues.values }),
          };
        });
      }
      return matching.map((command) => ({
        id: `workflow-suggest:${command.definition.id}`,
        label: `/${command.alias}`,
        description: `${command.definition.displayName} · ${workflowCommandUsage(command.alias, command.document.inputs)}`,
        icon: <Workflow className="h-4 w-4" />,
        closeOnRun: false,
        run: () => {
          setQuery(`/${command.alias}${command.document.inputs.length > 0 ? " " : ""}`);
          window.setTimeout(() => inputRef.current?.focus(), 0);
        },
      }));
    }

    const queryLower = cleanQuery.toLowerCase();
    const filtered = queryLower
      ? baseActions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(queryLower))
      : baseActions;
    const commandSuggestions = !queryLower
      ? workflowCommands.slice(0, 5).map((command): PaletteAction => ({
          id: `workflow-home:${command.definition.id}`,
          label: `/${command.alias}`,
          description: `${command.definition.displayName} · ${workflowCommandUsage(command.alias, command.document.inputs)}`,
          icon: <Workflow className="h-4 w-4" />,
          closeOnRun: false,
          run: () => {
            setQuery(`/${command.alias}${command.document.inputs.length > 0 ? " " : ""}`);
            window.setTimeout(() => inputRef.current?.focus(), 0);
          },
        }))
      : [];
    if (!codeMatch) return [...commandSuggestions, ...filtered];
    const code = cleanQuery.toUpperCase();
    return [
      {
        id: `code:${code}`,
        label: `Open ${code}`,
        description: "Open work detail by code",
        icon: <FileAudio className="h-4 w-4" />,
        run: () => onOpenPath(`/${encodeURIComponent(code)}`),
      },
      ...filtered,
    ];
  }, [baseActions, cleanQuery, codeMatch, onOpenPath, parsedCommand, workflowCommands]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setWorkflowLaunch(null);
    handleWorkflowBusyChange(false);
    setActionBusy(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    if (!hasPermission("workflows:run")) {
      setDefinitions([]);
      setLoadingWorkflows(false);
      return;
    }
    setLoadingWorkflows(true);
    api
      .listWorkflowDefinitions()
      .then(setDefinitions)
      .catch(() => setDefinitions([]))
      .finally(() => setLoadingWorkflows(false));
  }, [handleWorkflowBusyChange, hasPermission, open]);

  useEffect(() => {
    onBusyChange?.(workflowLaunchBusy || actionBusy !== null);
  }, [actionBusy, onBusyChange, workflowLaunchBusy]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (workflowLaunch) {
          if (!workflowLaunchBusy) setWorkflowLaunch(null);
          return;
        }
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onOpenChange, workflowLaunch, workflowLaunchBusy]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;
  if (workflowLaunch) {
    const parsed = parseWorkflowDefinition(workflowLaunch.definition.definitionJson);
    return (
      <WorkflowRunDialog
        definition={workflowLaunch.definition}
        initialInputs={workflowLaunch.inputs}
        autoPreview
        autoConfirmWhenAllowed={parsed.kind === "v2" && !parsed.document.policy.requirePreview}
        onClose={() => setWorkflowLaunch(null)}
        onBusyChange={handleWorkflowBusyChange}
        onQueued={(runId) => {
          setWorkflowLaunch(null);
          onOpenChange(false);
          onOpenPath(`/activity?view=running&run=${runId}`);
        }}
      />
    );
  }

  const runAction = async (index: number) => {
    const action = actions[index];
    if (!action || action.disabled || actionBusy) return;
    if (action.closeOnRun !== false) onOpenChange(false);
    try {
      const result = action.run();
      if (result instanceof Promise) {
        setActionBusy(action.id);
        await result;
      }
    } catch (error) {
      toast.notify(toastFromError(error, "Command could not be completed."));
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div
      className="visual-viewport-layer z-50 flex min-h-0 bg-background/55 p-2 backdrop-blur-sm sm:p-4 lg:block"
      onMouseDown={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden rounded-md border bg-card shadow-xl lg:mt-[10vh] lg:flex-none lg:max-h-[76vh]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-14 items-center gap-3 border-b px-4">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, Math.max(0, actions.length - 1)));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void runAction(activeIndex);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder="Search, open a work code, or type /workflow"
          />
          {loadingWorkflows && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading workflow commands" />
          )}
          <Button variant="ghost" size="icon" aria-label="Close command palette" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="app-scroll min-h-0 flex-1 overflow-auto p-2">
          {actions.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {parsedCommand.isCommand ? "No published workflow command matches." : "No commands match."}
            </div>
          ) : (
            actions.map((action, index) => (
              <button
                key={action.id}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm",
                  action.disabled && "cursor-not-allowed opacity-55",
                  index === activeIndex ? "bg-muted text-foreground" : "hover:bg-muted",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => void runAction(index)}
                disabled={action.disabled || actionBusy !== null}
              >
                <span className="text-muted-foreground">
                  {actionBusy === action.id ? <Loader2 className="h-4 w-4 animate-spin" /> : action.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{action.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{action.description}</span>
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
