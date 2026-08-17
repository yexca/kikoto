import { describe, expect, it } from "vitest";

import type { WorkMetadataPresentation } from "@/lib/api";
import { resolveMetadataVariant } from "./metadataPresentationModel";

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
});
