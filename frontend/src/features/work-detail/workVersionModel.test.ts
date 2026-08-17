import { describe, expect, it } from "vitest";

import type { WorkTranslation } from "@/lib/api";
import {
  groupWorkVersions,
  mergeRemoteWorkVersions,
  metadataOnlyVersionCount,
  preferredWorkVersion,
  workVersionAvailable,
} from "./workVersionModel";

describe("workVersionModel", () => {
  it("groups same-language identities without merging their work codes", () => {
    const versions = [
      version("SAMPLE-ORIGIN", "JPN", "origin", "indexed_available", 1),
      version("SAMPLE-EN-METADATA", "ENG", "unknown", "metadata_only", null),
      version("SAMPLE-EN-LOCAL", "en-US", "third_party", "present_unindexed", 2),
    ];

    const groups = groupWorkVersions(versions, {
      activeCode: "SAMPLE-ORIGIN",
      remoteVersions: false,
      includeMetadataOnly: true,
    });

    expect(groups).toHaveLength(2);
    expect(groups[1].versions.map((item) => item.primaryCode)).toEqual(["SAMPLE-EN-LOCAL", "SAMPLE-EN-METADATA"]);
  });

  it("keeps aliases inside usable language groups while hiding metadata-only languages", () => {
    const versions = [
      version("SAMPLE-ORIGIN", "JPN", "origin", "indexed_available", 1),
      version("SAMPLE-EN-METADATA", "ENG", "unknown", "metadata_only", null),
      version("SAMPLE-EN-LOCAL", "ENG", "third_party", "present_unindexed", 2),
      version("SAMPLE-KO-METADATA", "KO_KR", "unknown", "metadata_only", null),
    ];

    const groups = groupWorkVersions(versions, {
      activeCode: "SAMPLE-ORIGIN",
      remoteVersions: false,
      includeMetadataOnly: false,
    });

    expect(groups.flatMap((group) => group.versions).map((item) => item.primaryCode)).toEqual([
      "SAMPLE-ORIGIN",
      "SAMPLE-EN-LOCAL",
      "SAMPLE-EN-METADATA",
    ]);
    expect(metadataOnlyVersionCount(versions)).toBe(2);
    expect(workVersionAvailable(versions[2])).toBe(true);
    expect(workVersionAvailable(versions[1])).toBe(false);
    expect(workVersionAvailable(versions[1], true)).toBe(false);
  });

  it("prefers the smallest usable code instead of a smaller metadata-only alias", () => {
    const versions = [
      version("RJ00000000", "ENG", "official", "metadata_only", null),
      version("RJ00000002", "ENG", "third_party", "indexed_available", 3),
      version("RJ00000001", "ENG", "third_party", "indexed_available", 2),
    ];

    expect(preferredWorkVersion(versions, "")?.primaryCode).toBe("RJ00000001");
    expect(preferredWorkVersion(versions, "RJ00000002")?.primaryCode).toBe("RJ00000002");
    expect(preferredWorkVersion(versions, "", true)?.primaryCode).toBe("RJ00000001");
  });

  it("marks only remote-confirmed siblings available while retaining real local directories", () => {
    const local = [
      version("RJ00000000", "JPN", "origin", "indexed_available", 1),
      version("RJ00000001", "ENG", "official", "metadata_only", null),
      version("RJ00000002", "CHI_HANS", "official", "metadata_only", null),
      version("RJ00000003", "CHI_HANT", "official", "present_unindexed", 3),
      version("RJ00000004", "KO_KR", "official", "metadata_only", null),
    ];
    const merged = mergeRemoteWorkVersions(local, [
      remoteEdition("RJ00000000", "JPN", true, true),
      remoteEdition("RJ00000001", "ENG", false, false),
      remoteEdition("RJ00000002", "CHI_HANS", false, false),
    ]);

    expect(merged.filter((item) => workVersionAvailable(item)).map((item) => item.primaryCode)).toEqual([
      "RJ00000000",
      "RJ00000001",
      "RJ00000002",
      "RJ00000003",
    ]);
    expect(merged.find((item) => item.primaryCode === "RJ00000004")?.mediaState).toBe("metadata_only");
  });
});

function remoteEdition(remoteCode: string, language: string, current: boolean, origin: boolean) {
  return { remoteCode, language, label: remoteCode, displayOrder: 1, current, origin };
}

function version(
  primaryCode: string,
  metadataLanguage: string,
  translationKind: WorkTranslation["translationKind"],
  mediaState: WorkTranslation["mediaState"],
  workId: number | null,
): WorkTranslation {
  return {
    workId,
    primaryCode,
    title: primaryCode,
    metadataLanguage,
    editionLabel: "",
    origin: translationKind === "origin",
    official: translationKind === "official",
    translationKind,
    current: false,
    hasMedia: mediaState === "indexed_available",
    mediaState,
  };
}
