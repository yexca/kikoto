import type { RemoteWorkPreview, WorkPreview } from "@/features/work-detail/workDetailShared";
import type { RemoteWork } from "@/lib/api";

function historyPreviewValue() {
  return (window.history.state as { workPreview?: unknown } | null)?.workPreview;
}

function historyPreviewObject<T extends object>(code: string | null, field: keyof T) {
  const value = historyPreviewValue();
  if (!code || !value || typeof value !== "object") return null;
  const preview = value as Partial<T>;
  const candidate = preview[field];
  if (typeof candidate !== "string" || candidate.toUpperCase() !== code.toUpperCase()) return null;
  return preview;
}

function historyPreviewID(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function historyPreviewString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function historyPreviewNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function historyPreviewNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function historyPreviewStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function workPreviewFieldsFromHistory(preview: Partial<WorkPreview>): WorkPreview {
  const primaryCode = historyPreviewString(preview.primaryCode);
  return {
    primaryCode,
    title: historyPreviewString(preview.title, primaryCode),
    coverUrl: historyPreviewString(preview.coverUrl),
    circle: historyPreviewString(preview.circle),
    circleExternalId: historyPreviewString(preview.circleExternalId),
    rating: historyPreviewNumber(preview.rating),
    sales: historyPreviewNumber(preview.sales),
    releaseDate: historyPreviewNullableString(preview.releaseDate),
    tags: historyPreviewStringArray(preview.tags),
    voiceActors: historyPreviewStringArray(preview.voiceActors),
  };
}

export function workPreviewFromHistory(code: string | null): WorkPreview | null {
  const preview = historyPreviewObject<WorkPreview>(code, "primaryCode");
  if (!preview) return null;
  return { id: historyPreviewID(preview.id), ...workPreviewFieldsFromHistory(preview) };
}

export function remoteWorkPreview(work: RemoteWork): WorkPreview {
  return {
    id: work.workId ?? undefined,
    primaryCode: work.primaryCode,
    title: work.title || work.primaryCode,
    coverUrl: work.coverUrl,
    circle: work.circle,
    circleExternalId: work.circleRef?.externalId ?? "",
    rating: work.rating,
    sales: work.sales,
    releaseDate: work.releaseDate || null,
    tags: work.tags,
    voiceActors: work.voiceActors,
  };
}

export function remoteOnlyWorkPreview(work: RemoteWork): RemoteWorkPreview {
  return {
    ...remoteWorkPreview(work),
    remoteId: work.remoteId,
    remoteCode: work.remoteCode,
    ageRating: work.ageRating,
  };
}

export function remoteWorkPreviewFromHistory(code: string | null): RemoteWorkPreview | null {
  const preview = historyPreviewValue();
  if (!code || !preview || typeof preview !== "object") return null;
  const value = preview as Partial<RemoteWorkPreview>;
  const routeCode = remoteHistoryRouteCode(value);
  if (!routeCode || routeCode.toUpperCase() !== code.toUpperCase()) return null;
  if (typeof value.primaryCode !== "string" || typeof value.remoteCode !== "string") return null;
  return {
    ...workPreviewFieldsFromHistory(value),
    id: historyPreviewID(value.id),
    remoteId: historyPreviewString(value.remoteId) || undefined,
    remoteCode: value.remoteCode,
    ageRating: historyPreviewString(value.ageRating),
  };
}

function remoteHistoryRouteCode(preview: Partial<RemoteWorkPreview>) {
  return (
    historyPreviewString(preview.remoteCode) ||
    historyPreviewString(preview.primaryCode) ||
    historyPreviewString(preview.remoteId)
  );
}
