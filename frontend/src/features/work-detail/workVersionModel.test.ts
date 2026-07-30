import { describe, expect, it } from "vitest";

import type { WorkTranslation } from "@/lib/api";
import {
  groupWorkVersions,
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
    expect(groups[1].versions.map((item) => item.primaryCode)).toEqual([
      "SAMPLE-EN-LOCAL",
      "SAMPLE-EN-METADATA",
    ]);
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
  });

  it("prefers the smallest usable code instead of a smaller metadata-only alias", () => {
    const versions = [
      version("RJ09999787", "ENG", "official", "metadata_only", null),
      version("RJ09999790", "ENG", "third_party", "indexed_available", 3),
      version("RJ09999788", "ENG", "third_party", "indexed_available", 2),
    ];

    expect(preferredWorkVersion(versions, "")?.primaryCode).toBe("RJ09999788");
    expect(preferredWorkVersion(versions, "RJ09999790")?.primaryCode).toBe("RJ09999790");
  });
});

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
