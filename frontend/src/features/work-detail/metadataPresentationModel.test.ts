import { describe, expect, it } from "vitest";

import type { WorkMetadataPresentation } from "@/lib/api";
import {
  metadataLanguageChoices,
  metadataSourceGroups,
  metadataVariantLabel,
  orderedMetadataVariants,
  resolveMetadataVariant,
} from "./metadataPresentationModel";

const presentation: WorkMetadataPresentation = {
  defaultVariantKey: "RJ00000051",
  variants: [
    { key: "RJ00000050", language: "ja-jp", title: "Origin", tags: ["Origin tag"], origin: true },
    { key: "RJ00000051", language: "en-us", title: "English", tags: ["English tag"], origin: false },
  ],
};

describe("resolveMetadataVariant", () => {
  it("uses the configured default without a temporary selection", () => {
    expect(resolveMetadataVariant(presentation, "")?.key).toBe("RJ00000051");
  });

  it("uses a temporary selection and falls back when it disappears", () => {
    expect(resolveMetadataVariant(presentation, "RJ00000050")?.title).toBe("Origin");
    expect(resolveMetadataVariant(presentation, "missing")?.key).toBe("RJ00000051");
  });

  it("orders Origin first without changing the configured default", () => {
    const unsorted: WorkMetadataPresentation = {
      defaultVariantKey: "RJ00000051",
      variants: [
        { key: "RJ00000051", language: "en-us", title: "English", tags: [], origin: false },
        { key: "RJ00000050", language: "ja-jp", title: "Origin", tags: [], origin: true },
      ],
    };
    expect(orderedMetadataVariants(unsorted.variants).map((variant) => variant.key)).toEqual([
      "RJ00000050",
      "RJ00000051",
    ]);
    expect(resolveMetadataVariant(unsorted, "")?.key).toBe("RJ00000051");
  });
});

describe("metadataVariantLabel", () => {
  const labels = {
    original: "Original",
    language: (value: string) => ({ "ja-jp": "Japanese", "en-us": "English" })[value] ?? (value || "Unknown language"),
  };

  it("shows only Original when the original edition declares no language", () => {
    const variants = [
      { key: "RJ00000050", language: "", title: "Origin", tags: [], origin: true },
      { key: "RJ00000051", language: "en-us", title: "English", tags: [], origin: false },
    ];
    expect(metadataVariantLabel(variants[0], labels)).toBe("Original");
    expect(metadataVariantLabel(variants[1], labels)).toBe("English");
  });

  it("keeps declared and unknown labels for the other editions", () => {
    const variants = [
      { key: "RJ00000050", language: "ja-jp", title: "Origin", tags: [], origin: true },
      { key: "RJ00000051", language: "", title: "Undeclared", tags: [], origin: false },
    ];
    expect(metadataVariantLabel(variants[0], labels)).toBe("Original · Japanese");
    expect(metadataVariantLabel(variants[1], labels)).toBe("Unknown language");
  });
});

describe("metadataLanguageChoices", () => {
  const multilingual: WorkMetadataPresentation = {
    defaultVariantKey: "RJ00000052",
    variants: [
      { key: "RJ00000051", language: "zh-cn", title: "Chinese A", tags: [], origin: false },
      { key: "RJ00000050", language: "ja-jp", title: "Origin", tags: [], origin: true },
      { key: "RJ00000052", language: "zh-cn", title: "Chinese B", tags: [], origin: false },
      { key: "manual:en-us", language: "en-us", title: "Manual English", tags: [], origin: false },
    ],
  };

  it("offers one choice per language, original first", () => {
    const choices = metadataLanguageChoices(multilingual, "");
    expect(choices.map((choice) => choice.key)).toEqual(["language:ja-jp", "language:zh-cn", "language:en-us"]);
  });

  it("shows the selected or default edition for a shared language", () => {
    expect(metadataLanguageChoices(multilingual, "")[1].variant.key).toBe("RJ00000052");
    expect(metadataLanguageChoices(multilingual, "RJ00000051")[1].variant.key).toBe("RJ00000051");
    expect(metadataLanguageChoices({ ...multilingual, defaultVariantKey: "RJ00000050" }, "")[1].variant.key).toBe(
      "RJ00000051",
    );
  });

  it("keeps the original marker on a language whose shown edition is a translation", () => {
    const presentation: WorkMetadataPresentation = {
      defaultVariantKey: "RJ00000051",
      variants: [
        { key: "RJ00000050", language: "ja-jp", title: "Origin", tags: [], origin: true },
        { key: "RJ00000051", language: "ja-jp", title: "Reissue", tags: [], origin: false },
      ],
    };
    const [choice] = metadataLanguageChoices(presentation, "");
    expect(choice.variant).toMatchObject({ key: "RJ00000051", origin: true });
  });

  it("keeps editions without a declared language separate", () => {
    const presentation: WorkMetadataPresentation = {
      defaultVariantKey: "",
      variants: [
        { key: "RJ00000050", language: "", title: "Origin", tags: [], origin: true },
        { key: "RJ00000051", language: "", title: "Undeclared", tags: [], origin: false },
      ],
    };
    expect(metadataLanguageChoices(presentation, "")).toHaveLength(2);
  });
});

describe("metadataSourceGroups", () => {
  it("groups each remote source's fields in the server order", () => {
    expect(
      metadataSourceGroups([
        { field: "title", source: "Example Remote A" },
        { field: "circle", source: "Example Remote B" },
        { field: "tags", source: "Example Remote A" },
      ]),
    ).toEqual([
      { source: "Example Remote A", fields: ["title", "tags"] },
      { source: "Example Remote B", fields: ["circle"] },
    ]);
    expect(metadataSourceGroups(null)).toEqual([]);
  });
});
