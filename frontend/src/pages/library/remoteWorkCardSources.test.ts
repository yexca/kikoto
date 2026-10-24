import { describe, expect, it } from "vitest";

import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import type { RemoteWork, SourcePresenceItem } from "@/lib/api";

import { libraryCoverSourceBadges } from "./libraryCoverSources";
import { remoteWorkSourceBadges } from "./remoteWorkCardSources";

function remoteCard(overrides: Partial<RemoteWork>): RemoteWork {
  return {
    remoteId: "1",
    primaryCode: "RJ00000000",
    remoteCode: "RJ00000000",
    title: "Example Work",
    releaseDate: "",
    updatedAt: "",
    coverUrl: "",
    circle: "",
    ageRating: "",
    rating: null,
    sales: null,
    price: null,
    tags: [],
    voiceActors: [],
    voiceRefs: [],
    importStatus: "remote_only",
    remotePlayable: true,
    workId: null,
    favorite: false,
    listeningStatus: "none",
    recommendScore: 0,
    sourcePresence: [],
    availability: [],
    userTags: [],
    editions: [],
    ...overrides,
  };
}

const browsedListing: SourcePresenceItem = {
  type: "source",
  availability: "available",
  fileSourceId: 7,
  fileSourceName: "Example Remote",
};
const otherListing: SourcePresenceItem = {
  type: "source",
  availability: "available",
  fileSourceId: 8,
  fileSourceName: "Other Remote",
};

const coverLabels = (work: RemoteWork, mode: SourceVisibilityMode) =>
  libraryCoverSourceBadges(
    remoteWorkSourceBadges(work, 7, "Example Remote"),
    { kind: "remote", sourceId: 7 },
    mode,
  ).sourceBadges.map((badge) => badge.label);

describe("remote card source marks", () => {
  it("shows a local copy beside the browsed source", () => {
    const local = remoteCard({
      importStatus: "synced",
      workId: 1,
      sourcePresence: [{ type: "local", availability: "available" }, browsedListing, otherListing],
      availability: ["local"],
    });
    expect(coverLabels(local, "always")).toEqual(["Local", "Example Remote", "Other Remote"]);
    expect(coverLabels(local, "auto")).toEqual(["Local"]);
    expect(coverLabels(local, "never")).toEqual([]);
  });

  it("keeps only the browsed source for a work the library does not hold", () => {
    expect(coverLabels(remoteCard({}), "always")).toEqual(["Example Remote"]);
    expect(coverLabels(remoteCard({}), "auto")).toEqual([]);
  });

  it("does not call a work served by the browsed source missing", () => {
    const metadataOnly = remoteCard({ importStatus: "synced", workId: 1, availability: ["missing"] });
    expect(coverLabels(metadataOnly, "always")).toEqual(["Example Remote"]);
    expect(coverLabels(metadataOnly, "auto")).toEqual([]);
  });
});
