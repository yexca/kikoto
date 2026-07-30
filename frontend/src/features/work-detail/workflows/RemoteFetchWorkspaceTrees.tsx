import {
  ChevronDown,
  ChevronRight,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  HardDrive,
  Image as ImageIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  formatBytes,
  remoteSelectablePaths,
  type TreeNode,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import { type RemoteFetchFileDecision, type RemoteFetchResolution, type RemoteWorkSavePlan } from "@/lib/api";

type RemoteFetchDecisions = Record<string, RemoteFetchFileDecision>;

type RemoteFetchResultNode = {
  name: string;
  path: string;
  children: Map<string, RemoteFetchResultNode>;
  items: RemoteWorkSavePlan["items"];
};

export function RemoteFetchResultTree({
  plan,
  decisions,
  onDecisionChange,
}: {
  plan: RemoteWorkSavePlan;
  decisions: RemoteFetchDecisions;
  onDecisionChange?: (decision: RemoteFetchFileDecision) => void;
}) {
  const root = useMemo(() => {
    const result: RemoteFetchResultNode = { name: "", path: "", children: new Map(), items: [] };
    const prefix = `${plan.saveRoot.replace(/\\/g, "/").replace(/\/$/, "")}/`;
    for (const item of plan.items) {
      const normalized = item.targetPath.replace(/\\/g, "/");
      const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
      const parts = relative.split("/").filter(Boolean);
      let node = result;
      for (const folder of parts.slice(0, -1)) {
        const path = node.path ? `${node.path}/${folder}` : folder;
        if (!node.children.has(folder))
          node.children.set(folder, { name: folder, path, children: new Map(), items: [] });
        node = node.children.get(folder)!;
      }
      node.items.push({ ...item, path: parts.length > 0 ? parts[parts.length - 1] : item.path });
    }
    return result;
  }, [plan]);
  return (
    <RemoteFetchResultNodeView node={root} depth={0} decisions={decisions} onDecisionChange={onDecisionChange} isRoot />
  );
}

function RemoteFetchResultNodeView({
  node,
  depth,
  decisions,
  onDecisionChange,
  isRoot = false,
}: {
  node: RemoteFetchResultNode;
  depth: number;
  decisions: RemoteFetchDecisions;
  onDecisionChange?: (decision: RemoteFetchFileDecision) => void;
  isRoot?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const folders = Array.from(node.children.values()).sort((left, right) => naturalCompare(left.name, right.name));
  const items = [...node.items].sort((left, right) => naturalCompare(left.path, right.path));
  return (
    <div className="space-y-1">
      {!isRoot && (
        <button
          type="button"
          className="flex min-h-7 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted"
          style={{ paddingLeft: depth * 14 + 8 }}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Folder className="h-4 w-4 text-primary" />
          <span className="truncate">{node.name}</span>
        </button>
      )}
      {(isRoot || open) &&
        folders.map((child) => (
          <RemoteFetchResultNodeView
            key={child.path}
            node={child}
            depth={depth + 1}
            decisions={decisions}
            onDecisionChange={onDecisionChange}
          />
        ))}
      {(isRoot || open) &&
        items.map((item) => {
          const decision = decisions[item.itemKey] ?? {
            itemKey: item.itemKey,
            sourceId: item.remoteSourceId,
            resolution: (item.resolution || "auto") as RemoteFetchResolution,
            targetPath: item.targetPath,
          };
          const showEditor = item.targetConflict || decision.resolution !== "auto" || item.sourceOptions.length > 1;
          const updateDecision = (patch: Partial<RemoteFetchFileDecision>) =>
            onDecisionChange?.({ ...decision, ...patch });
          return (
            <div
              key={item.itemKey || item.targetPath}
              className="rounded hover:bg-muted/60"
              style={{ marginLeft: (depth + 1) * 14 + 8 }}
              title={item.targetPath}
            >
              <div className="flex min-h-8 items-center gap-2 px-2 text-xs">
                {kindIcon(item.kind, "h-3.5 w-3.5")}
                <span className="min-w-0 flex-1 truncate">{item.path}</span>
                <Badge
                  variant={item.action === "skip" || item.targetConflict ? "outline" : "secondary"}
                  className={item.targetConflict ? "border-destructive/40 text-destructive" : ""}
                >
                  {fetchResultActionLabel(item.action)}
                </Badge>
              </div>
              {showEditor && (
                <div className="grid gap-2 border-t px-2 py-2 text-xs sm:grid-cols-2">
                  {item.sourceOptions.length > 1 && (
                    <label className="space-y-1">
                      <span className="text-muted-foreground">Remote source</span>
                      <select
                        className="h-8 w-full rounded-md border bg-background px-2"
                        value={decision.sourceId || item.remoteSourceId}
                        onChange={(event) => updateDecision({ sourceId: Number(event.target.value) })}
                      >
                        {item.sourceOptions.map((option) => (
                          <option key={option.sourceId} value={option.sourceId}>
                            {option.sourceName}
                            {option.path !== item.path ? ` · ${option.path}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {(item.targetConflict || decision.resolution !== "auto") && (
                    <label className="space-y-1">
                      <span className="text-muted-foreground">Conflict action</span>
                      <select
                        className="h-8 w-full rounded-md border bg-background px-2"
                        value={decision.resolution}
                        onChange={(event) =>
                          updateDecision({ resolution: event.target.value as RemoteFetchResolution })
                        }
                      >
                        <option value="auto">Unresolved</option>
                        <option value="keep_local">Keep local</option>
                        <option value="replace">Replace with selected source</option>
                        <option value="keep_both">Keep both</option>
                        <option value="rename">Rename incoming</option>
                        <option value="exclude">Exclude</option>
                      </select>
                    </label>
                  )}
                  {decision.resolution === "rename" && (
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-muted-foreground">Target path inside Fetch root</span>
                      <input
                        className="h-8 w-full rounded-md border bg-background px-2"
                        value={decision.targetPath}
                        onChange={(event) => updateDecision({ targetPath: event.target.value })}
                      />
                    </label>
                  )}
                  {item.targetConflictReason && (
                    <div className="text-destructive sm:col-span-2">{item.targetConflictReason}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

type RemoteFetchLocalTree = {
  name: string;
  path: string;
  children: Map<string, RemoteFetchLocalTree>;
  items: RemoteFetchLocalTreeItem[];
};

type RemoteFetchLocalTreeItem = {
  name: string;
  path: string;
  fullPath: string;
  sizeBytes: number | null;
};

export function RemoteFetchLocalTreeNode({
  node,
  depth,
  selectedLocalPaths,
  disabled,
  isRoot = false,
  onChange,
}: {
  node: RemoteFetchLocalTree;
  depth: number;
  selectedLocalPaths: Set<string>;
  disabled: boolean;
  isRoot?: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  const [open, setOpen] = useState(isRoot);
  const folders = Array.from(node.children.values()).sort((left, right) => naturalCompare(left.name, right.name));
  const items = [...node.items].sort((left, right) => naturalCompare(left.name, right.name));
  const descendantItems = remoteFetchLocalTreeItems(node);
  const selectedCount = descendantItems.filter((item) => selectedLocalPaths.has(item.fullPath)).length;
  const checked = descendantItems.length > 0 && selectedCount === descendantItems.length;
  const mixed = selectedCount > 0 && selectedCount < descendantItems.length;
  const toggleNode = () => {
    const selected = !checked;
    const next = new Set(selectedLocalPaths);
    for (const item of descendantItems) {
      if (selected) next.add(item.fullPath);
      else next.delete(item.fullPath);
    }
    onChange(next);
  };
  return (
    <div className="space-y-1">
      {!isRoot && (
        <div
          className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          <button
            className="rounded p-0.5 hover:bg-background"
            onClick={() => setOpen((value) => !value)}
            title={open ? "Collapse" : "Expand"}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <Checkbox
            checked={checked}
            indeterminate={mixed}
            disabled={disabled || descendantItems.length === 0}
            onCheckedChange={toggleNode}
            aria-label={`Select ${node.name}`}
          />
          <Folder className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate" title={node.path}>
            {node.name}
          </span>
          <span className="text-xs text-muted-foreground">
            {selectedCount}/{descendantItems.length}
          </span>
        </div>
      )}
      {(isRoot || open) &&
        folders.map((child) => (
          <RemoteFetchLocalTreeNode
            key={child.path}
            node={child}
            depth={isRoot ? 0 : depth + 1}
            selectedLocalPaths={selectedLocalPaths}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      {(isRoot || open) &&
        items.map((item) => (
          <label
            key={item.fullPath}
            className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted"
            style={{ paddingLeft: (isRoot ? 0 : depth + 1) * 14 + 8 }}
          >
            <span className="w-5" />
            <Checkbox
              checked={selectedLocalPaths.has(item.fullPath)}
              disabled={disabled}
              onCheckedChange={(checked) => {
                const next = new Set(selectedLocalPaths);
                if (checked) next.add(item.fullPath);
                else next.delete(item.fullPath);
                onChange(next);
              }}
              aria-label={`Select ${item.name}`}
            />
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={item.fullPath}>
              {item.name}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.sizeBytes)}</span>
          </label>
        ))}
    </div>
  );
}

export function RemoteSelectionNode({
  node,
  depth,
  selectedPaths,
  planByPath,
  disabled,
  isRoot = false,
  onChange,
}: {
  node: TreeNode;
  depth: number;
  selectedPaths: Set<string>;
  planByPath: Map<string, { status: string; targetConflict: boolean; targetConflictReason: string }>;
  disabled: boolean;
  isRoot?: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  const [open, setOpen] = useState(isRoot);
  const folders = Array.from(node.children.values()).sort((left, right) => naturalCompare(left.name, right.name));
  const files = [...node.files].sort((left, right) => naturalCompare(left.title, right.title));
  const hasChildren = folders.length > 0 || files.length > 0;
  const nodePaths = remoteSelectablePaths(node);
  const checkedCount = nodePaths.filter((path) => selectedPaths.has(path)).length;
  const checked = nodePaths.length > 0 && checkedCount === nodePaths.length;
  const mixed = checkedCount > 0 && checkedCount < nodePaths.length;
  const toggleNode = () => {
    const next = new Set(selectedPaths);
    for (const path of nodePaths) {
      if (checked) next.delete(path);
      else next.add(path);
    }
    onChange(next);
  };
  return (
    <div className="space-y-1">
      {!isRoot && (
        <div
          className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          <button
            className="rounded p-0.5 hover:bg-background"
            disabled={!hasChildren}
            onClick={() => setOpen((value) => !value)}
            title={open ? "Collapse" : "Expand"}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <Checkbox
            checked={checked}
            indeterminate={mixed}
            disabled={disabled || nodePaths.length === 0}
            onCheckedChange={toggleNode}
            aria-label={`Select ${node.name}`}
          />
          <Folder className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="text-xs text-muted-foreground">
            {checkedCount}/{nodePaths.length}
          </span>
        </div>
      )}
      {(isRoot || open) &&
        folders.map((child) => (
          <RemoteSelectionNode
            key={child.path}
            node={child}
            depth={isRoot ? 0 : depth + 1}
            selectedPaths={selectedPaths}
            planByPath={planByPath}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      {(isRoot || open) &&
        files.map((file) => {
          const path = file.sourcePath;
          const plan = planByPath.get(path);
          return (
            <label
              key={path}
              className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted"
              style={{ paddingLeft: (isRoot ? 0 : depth + 1) * 14 + 8 }}
            >
              <Checkbox
                checked={selectedPaths.has(path)}
                disabled={disabled}
                onCheckedChange={(nextChecked) => {
                  const next = new Set(selectedPaths);
                  if (nextChecked) next.add(path);
                  else next.delete(path);
                  onChange(next);
                }}
                aria-label={`Select ${file.title}`}
              />
              {fileIcon(file)}
              <span className="min-w-0 flex-1 truncate">{file.title}</span>
              {plan && (
                <span
                  className={
                    plan.targetConflict ? "max-w-48 truncate text-xs text-destructive" : "text-xs text-muted-foreground"
                  }
                  title={plan.targetConflictReason || plan.status}
                >
                  {plan.status}
                </span>
              )}
            </label>
          );
        })}
    </div>
  );
}

export function buildRemoteFetchLocalTree(plan?: RemoteWorkSavePlan | null) {
  const root: RemoteFetchLocalTree = { name: "", path: "", children: new Map(), items: [] };
  const localFiles = plan?.localFiles ?? [];
  const rootPrefix = commonLocalPathPrefix(localFiles.map((file) => file.path));
  for (const file of localFiles) {
    const displayPath = trimLocalRootPrefix(file.path, rootPrefix);
    const parts = displayPath.split(/[\\/]+/).filter(Boolean);
    let cursor = root;
    let cursorPath = "";
    for (const folder of parts.slice(0, -1)) {
      cursorPath = cursorPath ? `${cursorPath}/${folder}` : folder;
      let child = cursor.children.get(folder);
      if (!child) {
        child = { name: folder, path: cursorPath, children: new Map(), items: [] };
        cursor.children.set(folder, child);
      }
      cursor = child;
    }
    cursor.items.push({
      name: parts[parts.length - 1] ?? file.path,
      path: displayPath,
      fullPath: file.path,
      sizeBytes: file.sizeBytes,
    });
  }
  return root;
}

function remoteFetchLocalTreeItems(node: RemoteFetchLocalTree): RemoteFetchLocalTreeItem[] {
  return [...node.items, ...Array.from(node.children.values()).flatMap(remoteFetchLocalTreeItems)];
}

function commonLocalPathPrefix(paths: string[]) {
  if (paths.length === 0) return "";
  const splitPaths = paths.map((path) =>
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .slice(0, -1),
  );
  const prefix: string[] = [];
  for (let index = 0; ; index += 1) {
    const segment = splitPaths[0]?.[index];
    if (!segment || splitPaths.some((parts) => parts[index] !== segment)) break;
    prefix.push(segment);
  }
  return prefix.length <= 1 ? "" : prefix.join("/");
}

function trimLocalRootPrefix(path: string, prefix: string) {
  const normalized = path.replace(/\\/g, "/");
  if (!prefix) return normalized;
  const normalizedPrefix = normalized.startsWith("/") && !prefix.startsWith("/") ? `/${prefix}` : prefix;
  if (normalized === normalizedPrefix) return normalized.split("/").pop() ?? normalized;
  return normalized.startsWith(`${normalizedPrefix}/`) ? normalized.slice(normalizedPrefix.length + 1) : normalized;
}

export function remoteFetchCurrentEditionCode(plan: RemoteWorkSavePlan | null | undefined, activeEditionCode?: string) {
  const active = (activeEditionCode ?? "").trim();
  if (!plan) return active;
  const activeEdition = plan.preparation.editions.find(
    (edition) => edition.primaryCode.toUpperCase() === active.toUpperCase(),
  );
  if (activeEdition) return activeEdition.primaryCode;
  const plannedEdition = plan.preparation.editions.find(
    (edition) => edition.primaryCode.toUpperCase() === plan.primaryCode.toUpperCase(),
  );
  return plannedEdition?.primaryCode ?? plan.primaryCode;
}

function fetchResultActionLabel(action: string) {
  switch (action) {
    case "skip":
      return "Keep";
    case "copy_local":
      return "Local";
    case "cache_hit":
      return "Cached";
    case "cache_download":
      return "Add";
    case "conflict":
      return "Conflict";
    case "exclude":
      return "Excluded";
    default:
      return action;
  }
}

export function translationKindLabel(kind: string) {
  switch (kind) {
    case "origin":
      return "Origin";
    case "official":
      return "Official";
    case "community":
      return "Community";
    case "third_party":
      return "Third-party";
    default:
      return "Unknown";
  }
}

export function languageLabel(value: string) {
  switch (value.trim().toLowerCase()) {
    case "ja":
    case "ja-jp":
    case "jpn":
      return "Japanese";
    case "en":
    case "en-us":
    case "eng":
      return "English";
    case "zh":
    case "zh-cn":
    case "chi_hans":
      return "Simplified Chinese";
    case "zh-tw":
    case "chi_hant":
      return "Traditional Chinese";
    case "ko":
    case "ko-kr":
    case "ko_kr":
      return "Korean";
    default:
      return value || "Unknown";
  }
}

function fileIcon(file: TreeTrack) {
  return kindIcon(file.kind, "h-4 w-4");
}

function kindIcon(kind: string, sizeClass: string) {
  const className = `${sizeClass} text-muted-foreground`;
  if (kind === "audio") return <FileAudio className={className} />;
  if (kind === "video") return <FileVideo className={className} />;
  if (kind === "image") return <ImageIcon className={className} />;
  return <FileText className={className} />;
}

export function FetchPaneEmpty({ label }: { label: string }) {
  return (
    <div className="grid min-h-32 place-items-center rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

export function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
