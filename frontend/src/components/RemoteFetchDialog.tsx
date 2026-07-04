import { ChevronDown, ChevronRight, FileAudio, Folder, HardDriveDownload, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RemoteTrack } from "@/lib/api";

type RemoteFetchNode = {
  name: string;
  path: string;
  kind: string;
  sizeBytes: number | null;
  children: RemoteFetchNode[];
};

export function RemoteFetchDialog({
  title,
  tracks,
  selectedPaths,
  disabled,
  onChange,
  onClose,
  onFetch,
}: {
  title: string;
  tracks: RemoteTrack[];
  selectedPaths: Set<string>;
  disabled: boolean;
  onChange: (paths: Set<string>) => void;
  onClose: () => void;
  onFetch: () => void;
}) {
  const nodes = useMemo(() => toFetchNodes(tracks), [tracks]);
  const leafPaths = useMemo(() => flattenLeafPaths(nodes), [nodes]);
  const setAudioOnly = () => onChange(new Set(flattenLeaves(nodes).filter((node) => node.kind === "audio").map((node) => node.path)));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">Fetch selection</h3>
            <p className="truncate text-xs text-muted-foreground">{title}</p>
          </div>
          <Button variant="ghost" size="icon" title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Badge variant="secondary">{selectedPaths.size} / {leafPaths.length} files</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange(new Set(leafPaths))}>All</Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={setAudioOnly}>Audio</Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange(new Set())}>None</Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-card p-2">
          {nodes.length > 0 ? nodes.map((node) => (
            <RemoteFetchTreeNode key={node.path} node={node} selectedPaths={selectedPaths} disabled={disabled} onChange={onChange} />
          )) : <div className="p-3 text-sm text-muted-foreground">No remote files detected.</div>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t p-3">
          <Button variant="outline" onClick={onClose} disabled={disabled}>Cancel</Button>
          <Button onClick={onFetch} disabled={disabled || selectedPaths.size === 0}>
            <HardDriveDownload className="h-4 w-4" />
            Fetch
          </Button>
        </div>
      </div>
    </div>
  );
}

function RemoteFetchTreeNode({
  node,
  selectedPaths,
  disabled,
  onChange,
  depth = 0,
}: {
  node: RemoteFetchNode;
  selectedPaths: Set<string>;
  disabled: boolean;
  onChange: (paths: Set<string>) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isFolder = node.children.length > 0;
  const childLeaves = isFolder ? flattenLeafPaths(node.children) : [node.path];
  const selectedCount = childLeaves.filter((path) => selectedPaths.has(path)).length;
  const checked = childLeaves.length > 0 && selectedCount === childLeaves.length;
  const partial = selectedCount > 0 && !checked;
  const toggle = (nextChecked: boolean) => {
    const next = new Set(selectedPaths);
    childLeaves.forEach((path) => {
      if (nextChecked) next.add(path);
      else next.delete(path);
    });
    onChange(next);
  };
  return (
    <div>
      <div className="flex min-h-8 items-center gap-2 rounded px-2 text-sm hover:bg-background" style={{ paddingLeft: `${8 + depth * 18}px` }}>
        {isFolder ? (
          <button className="rounded p-0.5 hover:bg-muted" onClick={() => setOpen((value) => !value)} title={open ? "Collapse" : "Expand"}>
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : <span className="w-5" />}
        <input
          type="checkbox"
          checked={checked}
          ref={(element) => {
            if (element) element.indeterminate = partial;
          }}
          disabled={disabled || childLeaves.length === 0}
          onChange={(event) => toggle(event.target.checked)}
        />
        {isFolder ? <Folder className="h-4 w-4 text-primary" /> : <FileAudio className="h-4 w-4 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {!isFolder && <span className="text-xs text-muted-foreground">{formatBytes(node.sizeBytes)}</span>}
      </div>
      {isFolder && open && node.children.map((child) => (
        <RemoteFetchTreeNode key={child.path} node={child} selectedPaths={selectedPaths} disabled={disabled} onChange={onChange} depth={depth + 1} />
      ))}
    </div>
  );
}

function toFetchNodes(tracks: RemoteTrack[], parentPath = ""): RemoteFetchNode[] {
  return tracks.map((track, index) => {
    const name = (track.title ?? "").trim() || `Track ${index + 1}`;
    const path = parentPath ? `${parentPath}/${name}` : name;
    return {
      name,
      path,
      kind: track.type || "file",
      sizeBytes: track.sizeBytes,
      children: toFetchNodes(track.children ?? [], path),
    };
  });
}

function flattenLeaves(nodes: RemoteFetchNode[]): RemoteFetchNode[] {
  return nodes.flatMap((node) => node.children.length > 0 ? flattenLeaves(node.children) : [node]);
}

function flattenLeafPaths(nodes: RemoteFetchNode[]) {
  return flattenLeaves(nodes).map((node) => node.path);
}

export function remoteFetchPaths(tracks: RemoteTrack[]) {
  return flattenLeafPaths(toFetchNodes(tracks));
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
