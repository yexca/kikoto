export type WorkDetailSourceIntent = {
  sourceId: number;
  remoteCode: string;
};

export type WorkDetailIntent =
  | {
      kind: "known";
      canonicalCode: string;
      view?: "local" | "tracked";
      source?: WorkDetailSourceIntent | null;
    }
  | {
      kind: "remote-only";
      sourceId: number;
      remoteCode: string;
    };

export type WorkDetailNavigationOptions = {
  returnTo: string;
  returnLabel: string;
  workPreview?: unknown;
};

export function workDetailRoute(intent: WorkDetailIntent) {
  if (intent.kind === "remote-only") {
    const remoteCode = intent.remoteCode.trim();
    if (!remoteCode || !validSourceID(intent.sourceId)) return null;
    const params = new URLSearchParams({ source: String(intent.sourceId) });
    return `/${encodeURIComponent(remoteCode)}?${params.toString()}`;
  }

  const canonicalCode = intent.canonicalCode.trim();
  if (!canonicalCode) return null;
  const params = new URLSearchParams();
  if (intent.source) {
    const remoteCode = intent.source.remoteCode.trim();
    if (!remoteCode || !validSourceID(intent.source.sourceId)) return null;
    params.set("view", "remote");
    params.set("source", String(intent.source.sourceId));
    params.set("remoteCode", remoteCode);
  } else if (intent.view) {
    params.set("view", intent.view);
  }
  const query = params.toString();
  return `/${encodeURIComponent(canonicalCode)}${query ? `?${query}` : ""}`;
}

export function openWorkDetail(intent: WorkDetailIntent, options: WorkDetailNavigationOptions) {
  const route = workDetailRoute(intent);
  if (!route) return false;
  window.history.pushState({
    returnTo: options.returnTo,
    returnLabel: options.returnLabel,
    ...(options.workPreview === undefined ? {} : { workPreview: options.workPreview }),
  }, "", route);
  window.dispatchEvent(new Event("kikoto:navigation"));
  return true;
}

function validSourceID(value: number) {
  return Number.isInteger(value) && value > 0;
}
