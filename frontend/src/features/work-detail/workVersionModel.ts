import type { WorkTranslation } from "@/lib/api";

export type WorkVersionGroup = {
  key: string;
  language: string;
  origin: boolean;
  versions: WorkTranslation[];
};

type GroupWorkVersionsOptions = {
  activeCode: string;
  remoteVersions: boolean;
  includeMetadataOnly: boolean;
};

export function workVersionMediaState(version: WorkTranslation): WorkTranslation["mediaState"] {
  if (version.mediaState) return version.mediaState;
  if (!version.workId) return "metadata_only";
  return version.hasMedia ? "indexed_available" : "unavailable";
}

export function workVersionAvailable(version: WorkTranslation, remoteVersions = false) {
  if (remoteVersions) return true;
  const state = workVersionMediaState(version);
  return state === "indexed_available" || state === "present_unindexed";
}

export function groupWorkVersions(
  translations: WorkTranslation[],
  options: GroupWorkVersionsOptions,
): WorkVersionGroup[] {
  const activeCode = normalizedCode(options.activeCode);
  const groups = new Map<string, WorkVersionGroup>();
  for (const version of translations) {
    const active = normalizedCode(version.primaryCode) === activeCode;
    if (!options.includeMetadataOnly && workVersionMediaState(version) === "metadata_only" && !active) continue;
    const language = normalizedLanguage(version.metadataLanguage);
    const key = language ? `language:${language}` : `edition:${normalizedCode(version.primaryCode)}`;
    const group = groups.get(key) ?? { key, language: version.metadataLanguage, origin: false, versions: [] };
    group.origin = group.origin || version.origin;
    group.versions.push(version);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.versions.sort((left, right) =>
      versionRank(left, activeCode, options.remoteVersions) - versionRank(right, activeCode, options.remoteVersions)
      || translationKindRank(left.translationKind) - translationKindRank(right.translationKind)
      || left.primaryCode.localeCompare(right.primaryCode),
    );
  }
  return Array.from(groups.values());
}

export function metadataOnlyVersionCount(translations: WorkTranslation[]) {
  return translations.filter((version) => workVersionMediaState(version) === "metadata_only").length;
}

export function workVersionKindLabel(version: WorkTranslation) {
  switch (version.translationKind) {
    case "origin": return "Origin";
    case "official": return "Official";
    case "community": return "Community";
    case "third_party": return "Third-party";
    default: return workVersionMediaState(version) === "metadata_only" ? "Metadata" : "Edition";
  }
}

function versionRank(version: WorkTranslation, activeCode: string, remoteVersions: boolean) {
  if (normalizedCode(version.primaryCode) === activeCode) return 0;
  if (workVersionAvailable(version, remoteVersions)) return 1;
  if (version.workId) return 2;
  return 3;
}

function translationKindRank(kind: WorkTranslation["translationKind"]) {
  switch (kind) {
    case "origin": return 0;
    case "official": return 1;
    case "community": return 2;
    case "third_party": return 3;
    default: return 4;
  }
}

function normalizedCode(value: string) {
  return value.trim().toUpperCase();
}

function normalizedLanguage(value: string) {
  const language = value.trim().toUpperCase().replace(/-/g, "_");
  switch (language) {
    case "JA":
    case "JA_JP":
    case "JPN": return "JPN";
    case "EN":
    case "EN_US":
    case "ENG": return "ENG";
    case "KO":
    case "KO_KR": return "KO_KR";
    case "ZH":
    case "ZH_CN":
    case "CHI_HANS": return "CHI_HANS";
    case "ZH_TW":
    case "CHI_HANT": return "CHI_HANT";
    default: return language;
  }
}
