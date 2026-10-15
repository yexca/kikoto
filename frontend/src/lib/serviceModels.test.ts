import { describe, expect, it } from "vitest";

import { addModel, ENABLED_MODEL_LIMIT, removeModel, serviceModelChoices } from "./serviceModels";

describe("enabled models", () => {
  it("adds a trimmed model once", () => {
    expect(addModel(["first"], " second ")).toEqual(["first", "second"]);
    expect(addModel(["first"], "first")).toEqual(["first"]);
    expect(addModel(["first"], "  ")).toEqual(["first"]);
    const full = Array.from({ length: ENABLED_MODEL_LIMIT }, (_, index) => `model-${index}`);
    expect(addModel(full, "one-more")).toBe(full);
  });

  it("falls back to the first remaining model when the default is removed", () => {
    expect(removeModel(["first", "second"], "first", "first")).toEqual({ models: ["second"], defaultModel: "second" });
    expect(removeModel(["first", "second"], "first", "second")).toEqual({ models: ["first"], defaultModel: "first" });
    expect(removeModel(["first"], "first", "first")).toEqual({ models: [], defaultModel: "" });
  });
});

describe("serviceModelChoices", () => {
  it("lists every enabled model with each service's default first", () => {
    const choices = serviceModelChoices([
      { id: "one", defaultModel: "second", models: ["first", "second"] },
      { id: "two", defaultModel: "only", models: ["only"] },
    ]);
    expect(choices.map(({ service, model }) => [service.id, model])).toEqual([
      ["one", "second"],
      ["one", "first"],
      ["two", "only"],
    ]);
    expect(new Set(choices.map((choice) => choice.key)).size).toBe(3);
  });
});
