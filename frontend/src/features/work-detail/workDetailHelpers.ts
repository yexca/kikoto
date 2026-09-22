import { listeningStatusOptions, type RemoteWorkPreview } from "@/features/work-detail/workDetailShared";
import type { SourceTabInfo } from "@/features/work-detail/source/sourceContextModel";
import type { TreeStats } from "@/features/work-detail/media/mediaTreeModel";
import type { ListeningStatus, MediaItem, RemoteWorkDetail, SourcePresenceItem, WorkDetail } from "@/lib/api";
import i18n from "@/i18n";
import type { TFunction } from "i18next";

export const emptyRemoteWorkPreview: RemoteWorkPreview = {
  primaryCode: "",
  remoteCode: "",
  title: "",
  coverUrl: "",
  circle: "",
  circleExternalId: "",
  rating: null,
  sales: null,
  releaseDate: "",
  tags: [],
  voiceActors: [],
  ageRating: "",
};

export type ActiveSourceInfoModel = {
  label: string;
  kind: SourceTabInfo["kind"];
  status: SourceTabInfo["status"];
  statusLabel: string;
  stats: TreeStats;
  loading: boolean;
  metadataDurationSeconds: number | null;
};

export function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runId}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

export function trackedPresenceForRemoteSource(work: WorkDetail | null, sourceID: number, remoteCode: string) {
  const candidates = (work?.sourcePresence ?? []).filter(
    (item) => item.type === "tracked" && item.availability === "available" && item.fileSourceId === sourceID,
  );
  if (candidates.length === 0) return null;
  return (
    candidates.find((item) => item.remoteCode?.toUpperCase() === remoteCode.toUpperCase()) ??
    candidates.find((item) => item.workId === work?.id) ??
    candidates[0]
  );
}

export function workHasNoSource(work: {
  sourcePresence?: SourcePresenceItem[] | null;
  availability?: string[];
  mediaItems?: MediaItem[];
}) {
  const sourcePresence = work.sourcePresence ?? [];
  const hasPresence = sourcePresence.some((item) => item.type && item.type !== "location" && item.type !== "remote");
  if (hasPresence) return false;
  if (
    work.availability &&
    work.availability.some((item) => ["local", "cache", "cached", "remote"].includes(item.toLowerCase()))
  )
    return false;
  if ((work.mediaItems ?? []).some((item) => item.locations.some((location) => location.availability === "available")))
    return false;
  return true;
}

export function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

const languageLabels: Record<string, string> = {
  ja: "Japanese",
  "ja-jp": "Japanese",
  jpn: "Japanese",
  en: "English",
  "en-us": "English",
  eng: "English",
  zh: "Simplified Chinese",
  "zh-cn": "Simplified Chinese",
  chi_hans: "Simplified Chinese",
  "zh-tw": "Traditional Chinese",
  chi_hant: "Traditional Chinese",
  ko: "Korean",
  "ko-kr": "Korean",
  ko_kr: "Korean",
  id: "Indonesian",
  "id-id": "Indonesian",
  ind: "Indonesian",
  es: "Spanish",
  "es-es": "Spanish",
  spa: "Spanish",
  vi: "Vietnamese",
  "vi-vn": "Vietnamese",
  vie: "Vietnamese",
  pt: "Portuguese",
  "pt-br": "Portuguese",
  por: "Portuguese",
  fr: "French",
  "fr-fr": "French",
  fre: "French",
  de: "German",
  "de-de": "German",
  ger: "German",
  it: "Italian",
  "it-it": "Italian",
  ita: "Italian",
  th: "Thai",
  "th-th": "Thai",
  tha: "Thai",
  sv: "Swedish",
  "sv-se": "Swedish",
  swe: "Swedish",
};

export function languageLabel(value: string) {
  return languageLabels[value.trim().toLowerCase()] ?? (value || i18n.t("libraryDetail.unknownLanguage"));
}

export function detailReturnTarget(fallbackPath: string) {
  const state = window.history.state as { returnTo?: unknown; returnLabel?: unknown } | null;
  const path =
    typeof state?.returnTo === "string" && isInternalReturnPath(state.returnTo) ? state.returnTo : fallbackPath;
  const label =
    typeof state?.returnLabel === "string" && state.returnLabel.trim()
      ? state.returnLabel
      : i18n.t("detailActions.back");
  return { path, label };
}

export function isInternalReturnPath(path: string) {
  return path.startsWith("/") && !path.startsWith("//");
}

export function listeningStatusLabel(status: ListeningStatus, t?: TFunction) {
  const fallback = listeningStatusOptions.find((option) => option.value === status)?.label ?? "Unmarked";
  return t?.(`library.status.${status}`, { defaultValue: fallback }) ?? fallback;
}

export function remoteDetailActionCode(detail: RemoteWorkDetail) {
  return detail.remoteCode || detail.primaryCode || detail.remoteId;
}
