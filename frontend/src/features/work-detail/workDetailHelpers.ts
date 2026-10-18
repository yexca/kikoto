import { listeningStatusOptions, type RemoteWorkPreview } from "@/features/work-detail/workDetailShared";
import type { SourceTabInfo } from "@/features/work-detail/source/sourceContextModel";
import type { TreeStats } from "@/features/work-detail/media/mediaTreeModel";
import type { ListeningStatus, MediaItem, RemoteWorkDetail, SourcePresenceItem, WorkDetail } from "@/lib/api";
import { openLibraryTagSearch, type LibraryTagSearchKind } from "@/lib/libraryTagSearch";
import { parseServerTimestamp } from "@/lib/serverTimestamp";
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
  return parseServerTimestamp(value)?.toLocaleString() ?? value;
}

type DetailLanguage = {
  /** The language tag `Intl.DisplayNames` names when there is no translated name. */
  tag: string;
  /** The code a narrow header shows in place of the name. */
  short: string;
  nameKey?: string;
  /** The name used when the browser cannot name the tag. */
  name: string;
};

const detailLanguages: Record<string, DetailLanguage> = {
  ja: { tag: "ja", short: "JA", nameKey: "metadata.japanese", name: "Japanese" },
  en: { tag: "en", short: "EN", nameKey: "metadata.english", name: "English" },
  "zh-cn": { tag: "zh-Hans", short: "SC", nameKey: "metadata.simplifiedChinese", name: "Simplified Chinese" },
  "zh-tw": { tag: "zh-Hant", short: "TC", nameKey: "metadata.traditionalChinese", name: "Traditional Chinese" },
  ko: { tag: "ko", short: "KO", nameKey: "metadata.korean", name: "Korean" },
  id: { tag: "id", short: "ID", name: "Indonesian" },
  es: { tag: "es", short: "ES", name: "Spanish" },
  vi: { tag: "vi", short: "VI", name: "Vietnamese" },
  pt: { tag: "pt", short: "PT", name: "Portuguese" },
  fr: { tag: "fr", short: "FR", name: "French" },
  de: { tag: "de", short: "DE", name: "German" },
  it: { tag: "it", short: "IT", name: "Italian" },
  th: { tag: "th", short: "TH", name: "Thai" },
  sv: { tag: "sv", short: "SV", name: "Swedish" },
};

const detailLanguageAliases: Record<string, string> = {
  "ja-jp": "ja",
  jpn: "ja",
  "en-us": "en",
  eng: "en",
  zh: "zh-cn",
  "zh-hans": "zh-cn",
  "chi-hans": "zh-cn",
  "zh-hant": "zh-tw",
  "chi-hant": "zh-tw",
  "ko-kr": "ko",
  kor: "ko",
  "id-id": "id",
  ind: "id",
  "es-es": "es",
  spa: "es",
  "vi-vn": "vi",
  vie: "vi",
  "pt-br": "pt",
  por: "pt",
  "fr-fr": "fr",
  fre: "fr",
  "de-de": "de",
  ger: "de",
  "it-it": "it",
  ita: "it",
  "th-th": "th",
  tha: "th",
  "sv-se": "sv",
  swe: "sv",
};

function detailLanguage(value: string): DetailLanguage | undefined {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  return detailLanguages[detailLanguageAliases[normalized] ?? normalized];
}

/** Names an edition or metadata language in the interface language. */
export function languageLabel(value: string) {
  const language = detailLanguage(value);
  if (!language) return value.trim() || i18n.t("libraryDetail.unknownLanguage");
  if (language.nameKey) return i18n.t(language.nameKey);
  try {
    return new Intl.DisplayNames([i18n.language], { type: "language" }).of(language.tag) || language.name;
  } catch {
    return language.name;
  }
}

/**
 * The short code a narrow work header shows for a language, such as "JA" or
 * "SC". A spelling that already looks like a language tag is shown upper-case;
 * anything else, and an undeclared language, keeps its full label.
 */
export function languageShortLabel(value: string) {
  const language = detailLanguage(value);
  if (language) return language.short;
  const trimmed = value.trim();
  if (/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(trimmed)) return trimmed.toUpperCase().replace(/_/g, "-");
  return languageLabel(value);
}

export function detailReturnTarget(fallbackPath: string) {
  const state = window.history.state as { returnTo?: unknown; returnLabel?: unknown } | null;
  const path =
    typeof state?.returnTo === "string" && isInternalReturnPath(state.returnTo) ? state.returnTo : fallbackPath;
  const label =
    typeof state?.returnLabel === "string" && state.returnLabel.trim() ? state.returnLabel : i18n.t("common.back");
  return { path, label };
}

export function isInternalReturnPath(path: string) {
  return path.startsWith("/") && !path.startsWith("//");
}

/** Opens a tag search in the library view the detail was opened from. */
export function openDetailTagSearch(kind: LibraryTagSearchKind, tag: string) {
  openLibraryTagSearch(kind, tag, detailReturnTarget("/").path);
}

export function listeningStatusLabel(status: ListeningStatus, t?: TFunction) {
  const fallback = listeningStatusOptions.find((option) => option.value === status)?.label ?? "Unmarked";
  return t?.(`library.status.${status}`, { defaultValue: fallback }) ?? fallback;
}

export function remoteDetailActionCode(detail: RemoteWorkDetail) {
  return detail.remoteCode || detail.primaryCode || detail.remoteId;
}
