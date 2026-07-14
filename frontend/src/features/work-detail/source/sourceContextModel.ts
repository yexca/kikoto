import type {
  LibrarySource,
  MediaItem,
  RemoteWorkDetail,
  SourceAvailabilitySource,
  WorkDetail,
} from "@/lib/api";

export type DetailSourceIntent = "local" | "tracked";

export type SourceTabInfo = {
  key: string;
  label: string;
  fileSourceId: number | null;
  kind?: "local" | "remote" | "tracked" | "no_source";
  presence?: NonNullable<WorkDetail["sourcePresence"]>[number];
  status: "green" | "yellow" | "red";
  statusLabel: string;
};

export type RemoteSourceAvailability = {
  source: LibrarySource;
  summary: SourceAvailabilitySource;
  detail?: RemoteWorkDetail;
  loading?: boolean;
  error?: string;
};

export type ReforkTarget = {
  current: RemoteSourceAvailability | null;
  next: RemoteSourceAvailability;
};

export function sourceTabStatusClass(status: SourceTabInfo["status"]) {
  if (status === "green") return "bg-emerald-500";
  if (status === "yellow") return "bg-amber-500";
  return "bg-red-500";
}

export function buildSourceTabs(
  items: MediaItem[],
  remoteSources: RemoteSourceAvailability[] = [],
  sourcePresence: NonNullable<WorkDetail["sourcePresence"]> = [],
): SourceTabInfo[] {
  const sources = new Map<number, SourceTabInfo>();
  for (const item of items) {
    for (const location of item.locations) {
      if (location.locationType !== "local" || location.availability !== "available") continue;
      if (!sources.has(location.fileSourceId)) {
        sources.set(location.fileSourceId, {
          key: `${location.fileSourceId}:${location.locationType}`,
          label: "Local",
          fileSourceId: location.fileSourceId,
          kind: "local",
          status: "green",
          statusLabel: "Local files available",
        });
      }
    }
  }
  const availableRemotes = remoteSources.filter((remote) => remote.summary.status === "available");
  const pendingRemotes = remoteSources.filter((remote) => ["unknown", "error"].includes(remote.summary.status));
  const tabs = Array.from(sources.values());
  if (tabs.length === 0) {
    tabs.push({
      key: "local",
      label: "Local",
      fileSourceId: -1,
      kind: "local",
      status: availableRemotes.length > 0 || pendingRemotes.length > 0 || remoteSources.length === 0 ? "yellow" : "red",
      statusLabel: availableRemotes.length > 0
        ? `Fetch available from ${availableRemotes[0].source.displayName}`
        : pendingRemotes.length > 0 || remoteSources.length === 0
          ? "Remote sources need checking"
          : "No local or remote files available",
    });
  }
  const baseTabs: SourceTabInfo[] = [...tabs];
  for (const presence of sourcePresence) {
    if (presence.type !== "tracked") continue;
    const sourceID = trackedPresenceSourceID(presence);
    const forked = trackedPresenceForked(presence, items);
    const matchingRemote = remoteSources.find((remote) => remote.source.id === sourceID);
    const canFork = matchingRemote?.summary.status === "available" || availableRemotes.length > 0;
    const sourceName = presence.fileSourceName || presence.fileSourceCode || "Source";
    baseTabs.push({
      key: trackedSourceTabKey(presence),
      label: `Tracked · ${sourceName}`,
      fileSourceId: null,
      kind: "tracked",
      presence,
      status: forked ? "green" : canFork ? "yellow" : "red",
      statusLabel: forked
        ? "Tracked directory available"
        : canFork
          ? `Fork available from ${matchingRemote?.source.displayName ?? availableRemotes[0].source.displayName}`
          : "Tracked directory unavailable",
    });
  }
  for (const remote of remoteSources) {
    const status = remoteSourceTabStatus(remote.summary);
    baseTabs.push({
      key: remoteSourceTabKey(remote.source.id),
      label: remote.source.displayName,
      fileSourceId: null,
      kind: "remote",
      status: status.status,
      statusLabel: status.statusLabel,
    });
  }
  return baseTabs;
}

export function remoteSourceTabStatus(summary: SourceAvailabilitySource): Pick<SourceTabInfo, "status" | "statusLabel"> {
  if (summary.status === "available") return { status: "green", statusLabel: "Available" };
  if (summary.status === "unknown" || summary.status === "error") {
    return { status: "yellow", statusLabel: summary.status === "unknown" ? "Needs checking" : "Check failed" };
  }
  if (summary.status === "not_found") return { status: "red", statusLabel: "Not found" };
  if (summary.status === "disabled") return { status: "red", statusLabel: "Disabled" };
  return { status: "red", statusLabel: summary.error || "Unavailable" };
}

export function trackedPresenceSourceID(presence: NonNullable<WorkDetail["sourcePresence"]>[number] | null) {
  return presence?.fileSourceId ?? null;
}

export function trackedPresenceForked(presence: NonNullable<WorkDetail["sourcePresence"]>[number] | null, items: MediaItem[]) {
  const sourceID = trackedPresenceSourceID(presence);
  if (!sourceID) return false;
  return items.some((item) => item.locations.some((location) =>
    location.fileSourceId === sourceID
    && location.locationType === "remote_stream"
    && location.availability === "available",
  ));
}

export function availableForkSources(remoteSources: RemoteSourceAvailability[]) {
  return remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
}

export function remoteSourceForTrackedPresence(
  presence: NonNullable<WorkDetail["sourcePresence"]>[number] | null,
  remoteSources: RemoteSourceAvailability[],
) {
  const sourceID = trackedPresenceSourceID(presence);
  if (!sourceID) return null;
  return remoteSources.find((remote) => remote.source.id === sourceID) ?? null;
}

export function trackedSourceTabKey(presence: NonNullable<WorkDetail["sourcePresence"]>[number]) {
  return `tracked:${presence.fileSourceId ?? 0}:${presence.remoteId ?? ""}:${presence.sourceUrl ?? ""}`;
}

export function remoteSourceCanBrowse(summary: SourceAvailabilitySource) {
  return summary.status === "available";
}

export function remoteSourceTabKey(sourceID: number) {
  return `remote-source:${sourceID}`;
}

export function remoteAvailabilityRouteCode(summary: SourceAvailabilitySource, fallbackCode: string) {
  return fallbackCode || summary.primaryCode || summary.remoteId;
}
