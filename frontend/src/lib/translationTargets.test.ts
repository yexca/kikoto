import { describe, expect, it } from "vitest";

import { interfaceLyricsLanguage, modelTranslationTargets, translationTarget } from "@/lib/translationTargets";

const offered = ["ja-jp", "en-us", "zh-cn", "zh-tw", "ko-kr"];

describe("translation targets", () => {
  it("suggests the interface language for a model that translates any direction", () => {
    expect(translationTarget({ chosen: null, preferred: interfaceLyricsLanguage("en"), targets: null, offered })).toBe(
      "en-us",
    );
    expect(interfaceLyricsLanguage("zh-Hant")).toBe("zh-tw");
    expect(interfaceLyricsLanguage("fr")).toBe("en-us");
  });

  it("falls back to the model's supported target when the interface language is unsupported", () => {
    expect(translationTarget({ chosen: null, preferred: "en-us", targets: ["zh-cn"], offered })).toBe("zh-cn");
    expect(translationTarget({ chosen: null, preferred: "zh-cn", targets: ["ko-kr", "zh-cn"], offered })).toBe("zh-cn");
  });

  it("keeps a chosen target only while the model translates into it", () => {
    expect(translationTarget({ chosen: "ko-kr", preferred: "en-us", targets: null, offered })).toBe("ko-kr");
    expect(translationTarget({ chosen: "ko-kr", preferred: "en-us", targets: ["zh-cn"], offered })).toBe("zh-cn");
  });

  it("keeps the preferred target when the model offers no available language", () => {
    expect(translationTarget({ chosen: null, preferred: "en-us", targets: ["x-example"], offered })).toBe("en-us");
  });

  it("reads a model's targets and treats a model without an entry as unrestricted", () => {
    const service = { modelTargets: { restricted: ["zh-cn"] } };
    expect(modelTranslationTargets(service, "restricted")).toEqual(["zh-cn"]);
    expect(modelTranslationTargets(service, "open")).toBeNull();
    expect(modelTranslationTargets({}, "restricted")).toBeNull();
  });
});
