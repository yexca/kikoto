import type { RemoteLanguageEdition, WorkTranslation } from "@/lib/api";

export type WorkVersionGroup = {
  key: string;
  language: string;
  origin: boolean;
  versions: WorkTranslation[];
};

export type WorkVersionAvailabilityScope = "local" | "source" | "all";

type GroupWorkVersionsOptions = {
  activeCode: string;
  remoteVersions: boolean;
  includeMetadataOnly: boolean;
  availabilityScope?: WorkVersionAvailabilityScope;
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

export function workVersionAvailableForScope(version: WorkTranslation, scope: WorkVersionAvailabilityScope): boolean {
  if (scope === "local") return version.localAvailable === true;
  return workVersionAvailable(version);
}

function workVersionIncludedInScope(version: WorkTranslation, scope: WorkVersionAvailabilityScope) {
  return scope === "all" || workVersionAvailableForScope(version, scope);
}

function workVersionSelectableInScope(version: WorkTranslation, scope: WorkVersionAvailabilityScope) {
  return scope === "all" ? workVersionAvailable(version) : workVersionAvailableForScope(version, scope);
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
        localAvailable: false,
      }),
      hasMedia: true,
      mediaState: "indexed_available",
      localAvailable: local?.localAvailable === true,
    });
  }
  return Array.from(merged.values());
}

export function groupWorkVersions(
  translations: WorkTranslation[],
  options: GroupWorkVersionsOptions,
): WorkVersionGroup[] {
  const activeCode = normalizedCode(options.activeCode);
  const scope = options.availabilityScope ?? legacyAvailabilityScope(options.remoteVersions);
  const groups = new Map<string, WorkVersionGroup>();
  for (const version of translations) {
    if (
      !options.includeMetadataOnly &&
      !workVersionIncludedInScope(version, scope) &&
      normalizedCode(version.primaryCode) !== activeCode
    ) {
      continue;
    }
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
        versionRank(left, activeCode, scope) - versionRank(right, activeCode, scope) ||
        compareWorkCodes(left.primaryCode, right.primaryCode),
    );
  }
  const result = Array.from(groups.values());
  return result;
}

export function preferredWorkVersion(
  versions: WorkTranslation[],
  activeCode: string,
  scope: WorkVersionAvailabilityScope | boolean = "source",
) {
  const normalizedActiveCode = normalizedCode(activeCode);
  const availabilityScope = typeof scope === "boolean" ? legacyAvailabilityScope(scope) : scope;
  const available = versions.filter((version) => workVersionSelectableInScope(version, availabilityScope));
  const candidates = available.length > 0 ? available : versions;
  return (
    [...candidates].sort(
      (left, right) =>
        versionRank(left, normalizedActiveCode, availabilityScope) -
          versionRank(right, normalizedActiveCode, availabilityScope) ||
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

function versionRank(version: WorkTranslation, activeCode: string, scope: WorkVersionAvailabilityScope) {
  if (normalizedCode(version.primaryCode) === activeCode) return 0;
  if (workVersionSelectableInScope(version, scope)) return 1;
  switch (workVersionMediaState(version)) {
    case "indexed_available":
      return 2;
    case "present_unindexed":
      return 3;
    case "unavailable":
      return 4;
    case "metadata_only":
      return 5;
  }
}

function legacyAvailabilityScope(remoteVersions: boolean): WorkVersionAvailabilityScope {
  // The boolean argument predates explicit scopes and represented source-level
  // availability in both modes. Keep that behavior for non-UI callers.
  void remoteVersions;
  return "source";
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
