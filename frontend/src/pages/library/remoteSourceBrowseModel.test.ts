import { describe, expect, it } from "vitest";

import type { RemoteWork, RemoteWorkEdition } from "@/lib/api";

import {
  remoteWorkActionCode,
  remoteWorkEditionChoices,
  remoteWorkForEdition,
  remoteWorkPresentsEdition,
} from "./remoteSourceBrowseModel";

const origin: RemoteWorkEdition = {
  remoteId: "10",
  remoteCode: "RJ00000000",
  title: "Origin title",
  language: "ja-jp",
  label: "Japanese",
  origin: true,
};
const translation: RemoteWorkEdition = {
  remoteId: "11",
  remoteCode: "RJ00000001",
  title: "Translated title",
  language: "zh-cn",
  label: "Simplified Chinese",
  origin: false,
};

function familyCard(editions: RemoteWorkEdition[]): RemoteWork {
  return {
    remoteId: "11",
    primaryCode: "RJ00000000",
    remoteCode: "RJ00000001",
    title: "Translated title",
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
    importStatus: "synced",
    remotePlayable: true,
    workId: 1,
    favorite: false,
    listeningStatus: "none",
    recommendScore: 0,
    sourcePresence: [],
    availability: [],
    userTags: [],
    editions,
  };
}

describe("remote work editions", () => {
  it("offers a choice only when the source returned more than the presented edition", () => {
    expect(remoteWorkEditionChoices(familyCard([translation]))).toEqual([]);
    expect(remoteWorkEditionChoices(familyCard([origin, translation]))).toEqual([origin, translation]);
  });

  it("opens a folded edition by its own code while keeping the family identity", () => {
    const card = familyCard([origin, translation]);
    expect(remoteWorkPresentsEdition(card, translation)).toBe(true);
    expect(remoteWorkPresentsEdition(card, origin)).toBe(false);

    const opened = remoteWorkForEdition(card, origin);
    expect(remoteWorkActionCode(opened)).toBe("RJ00000000");
    expect(opened).toMatchObject({ remoteId: "10", primaryCode: "RJ00000000", title: "Origin title", workId: 1 });
  });
});
