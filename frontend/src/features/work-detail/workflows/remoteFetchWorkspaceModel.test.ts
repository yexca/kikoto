import { describe, expect, it } from "vitest";

import type { RemoteWorkDetail, RemoteWorkSavePlan } from "@/lib/api";
import {
  createDemoRemoteFetchPlan,
  createRemoteFetchDraft,
  createRemoteFetchRequestId,
  selectRemoteFetchEdition,
} from "./remoteFetchWorkspaceModel";

describe("remote fetch workspace model", () => {
  it("creates an opaque Fetch request id", () => {
    expect(createRemoteFetchRequestId(() => "stable-id")).toBe("fetch:stable-id");
  });

  it("keeps the request id while the same draft is reviewed", () => {
    const remoteDetail = detail("REMOTE-1");
    remoteDetail.primaryCode = "RJ00000000";
    const draft = createRemoteFetchDraft({
      intent: { sourceId: 7, remoteCode: "REMOTE-1", canonicalCode: "RJ00000000" },
      detail: remoteDetail,
      paths: ["Disc/01.mp3"],
      plan: plan("REMOTE-1"),
      requestId: "fetch:stable",
    });

    const reviewed = {
      ...draft,
      selectedPaths: new Set(["Disc/01.mp3", "Disc/02.mp3"]),
      targetRoot: "/data/REMOTE-1",
      planDirty: true,
    };

    expect(reviewed.requestId).toBe("fetch:stable");
    expect(reviewed.intent.remoteCode).toBe("REMOTE-1");
    expect(reviewed.intent.canonicalCode).toBe("RJ00000000");
  });

  it("starts a distinct idempotency scope when the selected edition changes", () => {
    const draft = createRemoteFetchDraft({
      intent: { sourceId: 7, remoteCode: "REMOTE-1" },
      detail: detail("REMOTE-1"),
      paths: ["01.mp3"],
      plan: plan("REMOTE-1"),
      requestId: "fetch:first-edition",
    });

    const changed = selectRemoteFetchEdition({
      draft,
      detail: detail("REMOTE-2"),
      paths: ["02.mp3"],
      requestId: "fetch:second-edition",
    });

    expect(changed.requestId).toBe("fetch:second-edition");
    expect(changed.intent.remoteCode).toBe("REMOTE-2");
    expect(changed.plan).toBeNull();
    expect(Array.from(changed.selectedPaths)).toEqual(["02.mp3"]);
  });

  it("builds a local-only preview plan for demo Fetch", () => {
    const remoteDetail = detail("REMOTE-1");
    remoteDetail.primaryCode = "RJ00000000";
    remoteDetail.languageEditions = [
      {
        remoteCode: "RJ00000000",
        language: "JPN",
        label: "Japanese",
        displayOrder: 0,
        current: true,
        origin: true,
      },
    ];
    remoteDetail.tracks = [
      {
        type: "folder",
        title: "Disc",
        hash: "",
        streamUrl: "",
        downloadUrl: "",
        durationSeconds: null,
        sizeBytes: null,
        cacheLocationId: null,
        cachePath: "",
        cacheAvailable: false,
        localLocationId: null,
        localPath: "",
        localAvailable: false,
        children: [
          {
            type: "audio",
            title: "01.mp3",
            hash: "track",
            streamUrl: "https://demo.invalid/01.mp3",
            downloadUrl: "https://demo.invalid/01.mp3",
            durationSeconds: 60,
            sizeBytes: 1024,
            cacheLocationId: null,
            cachePath: "",
            cacheAvailable: false,
            localLocationId: null,
            localPath: "",
            localAvailable: false,
            children: [],
          },
        ],
      },
    ];

    const preview = createDemoRemoteFetchPlan({ detail: remoteDetail, paths: ["Disc/01.mp3"] });

    expect(preview.saveRoot).toBe("/data/demo-preview/RJ00000000");
    expect(preview.summary).toMatchObject({ total: 1, promote: 1, conflict: 0 });
    expect(preview.items[0]).toMatchObject({
      action: "preview",
      status: "preview only",
      targetPath: "/data/demo-preview/RJ00000000/Disc/01.mp3",
    });
    expect(preview.preparation.warnings[0]).toContain("preview-only");
  });
});

function detail(remoteCode: string): RemoteWorkDetail {
  return {
    sourceId: 7,
    sourceCode: "example_remote",
    sourceName: "Example Remote",
    remoteId: remoteCode,
    primaryCode: remoteCode,
    remoteCode,
    title: "Synthetic work",
    coverUrl: "",
    sourceUrl: "",
    publicWorkUrl: "",
    circle: "Synthetic circle",
    rating: null,
    sales: null,
    price: null,
    ageRating: "unknown",
    releaseDate: "",
    durationSeconds: null,
    tags: [],
    voiceActors: [],
    importStatus: "remote",
    workId: null,
    tracks: [],
    languageEditions: [],
  };
}

function plan(code: string): RemoteWorkSavePlan {
  return {
    sourceId: 7,
    primaryCode: code,
    saveRoot: `/data/${code}`,
    fetchRoot: { rootPath: "", status: "not_applicable", conflict: false, message: "" },
    localFiles: [],
    items: [],
    summary: { total: 0, skipExisting: 0, cacheHit: 0, cacheDownload: 0, promote: 0, conflict: 0 },
    preparation: {
      requestedCode: code,
      canonicalCode: code,
      metadataStatus: "complete",
      warnings: [],
      editions: [],
    },
  };
}
