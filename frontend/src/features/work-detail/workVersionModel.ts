import type { RemoteLanguageEdition, WorkTranslation } from "@/lib/api";

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
  void remoteVersions;
  const state = workVersionMediaState(version);
  return state === "indexed_available" || state === "present_unindexed";
}

export function mergeRemoteWorkVersions(
  localVersions: WorkTranslation[],
  remoteEditions: RemoteLanguageEdition[],
): WorkTranslation[] {
  const merged = new Map(localVersions.map((version) => [normalizedCode(version.primaryCode), version]));
  for (const edition of remoteEditions) {
    const key = normalizedCode(edition.remoteCode);
    const local = merged.get(key);
    merged.set(key, {
      ...(local ?? {
        workId: null,
        primaryCode: edition.remoteCode,
        title: edition.label,
        metadataLanguage: edition.language,
        editionLabel: edition.label,
        origin: edition.origin,
        official: !edition.origin,
        translationKind: edition.origin ? ("origin" as const) : ("official" as const),
        current: edition.current,
      }),
      hasMedia: true,
      mediaState: "indexed_available",
    });
  }
  return Array.from(merged.values());
}

export function groupWorkVersions(
  translations: WorkTranslation[],
  options: GroupWorkVersionsOptions,
): WorkVersionGroup[] {
  const activeCode = normalizedCode(options.activeCode);
  const groups = new Map<string, WorkVersionGroup>();
  for (const version of translations) {
    const language = normalizedLanguage(version.metadataLanguage);
    const key = language ? `language:${language}` : `edition:${normalizedCode(version.primaryCode)}`;
    const group = groups.get(key) ?? { key, language: version.metadataLanguage, origin: false, versions: [] };
    group.origin = group.origin || version.origin;
    group.versions.push(version);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.versions.sort(
      (left, right) =>
        versionRank(left, activeCode, options.remoteVersions) -
          versionRank(right, activeCode, options.remoteVersions) ||
        compareWorkCodes(left.primaryCode, right.primaryCode),
    );
  }
  const result = Array.from(groups.values());
  if (options.includeMetadataOnly) return result;
  return result.filter((group) =>
    group.versions.some(
      (version) =>
        normalizedCode(version.primaryCode) === activeCode || workVersionMediaState(version) !== "metadata_only",
    ),
  );
}

export function preferredWorkVersion(versions: WorkTranslation[], activeCode: string, remoteVersions = false) {
  const normalizedActiveCode = normalizedCode(activeCode);
  return (
    [...versions].sort(
      (left, right) =>
        versionRank(left, normalizedActiveCode, remoteVersions) -
          versionRank(right, normalizedActiveCode, remoteVersions) ||
        compareWorkCodes(left.primaryCode, right.primaryCode),
    )[0] ?? null
  );
}

export function metadataOnlyVersionCount(translations: WorkTranslation[]) {
  return translations.filter((version) => workVersionMediaState(version) === "metadata_only").length;
}

export function workVersionKindLabel(version: WorkTranslation) {
  switch (version.translationKind) {
    case "origin":
      return "Origin";
    case "official":
      return "Official";
    case "community":
      return "Community";
    case "third_party":
      return "Third-party";
    default:
      return workVersionMediaState(version) === "metadata_only" ? "Metadata" : "Edition";
  }
}

function versionRank(version: WorkTranslation, activeCode: string, remoteVersions: boolean) {
  if (normalizedCode(version.primaryCode) === activeCode) return 0;
  void remoteVersions;
  switch (workVersionMediaState(version)) {
    case "indexed_available":
      return 1;
    case "present_unindexed":
      return 2;
    case "unavailable":
      return 3;
    case "metadata_only":
      return 4;
  }
}

function compareWorkCodes(left: string, right: string) {
  const normalizedLeft = normalizedCode(left);
  const normalizedRight = normalizedCode(right);
  const leftMatch = /^([A-Z]+)(\d+)$/.exec(normalizedLeft);
  const rightMatch = /^([A-Z]+)(\d+)$/.exec(normalizedRight);
  if (leftMatch && rightMatch && leftMatch[1] === rightMatch[1]) {
    const numericDifference = Number(leftMatch[2]) - Number(rightMatch[2]);
    if (numericDifference !== 0) return numericDifference;
  }
  return normalizedLeft.localeCompare(normalizedRight);
}

function normalizedCode(value: string) {
  return value.trim().toUpperCase();
}

function normalizedLanguage(value: string) {
  const language = value.trim().toUpperCase().replace(/-/g, "_");
  switch (language) {
    case "JA":
    case "JA_JP":
    case "JPN":
      return "JPN";
    case "EN":
    case "EN_US":
    case "ENG":
      return "ENG";
    case "KO":
    case "KO_KR":
      return "KO_KR";
    case "ZH":
    case "ZH_CN":
    case "CHI_HANS":
      return "CHI_HANS";
    case "ZH_TW":
    case "CHI_HANT":
      return "CHI_HANT";
    default:
      return language;
  }
}
