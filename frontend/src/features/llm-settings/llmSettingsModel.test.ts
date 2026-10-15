import { describe, expect, it } from "vitest";

import type { LLMPolicy, LLMProvider, LLMProviderPreset } from "@/lib/api";

import {
  contextLengthInvalid,
  createPayload,
  draftFromPreset,
  draftFromProvider,
  endpointMissing,
  policiesEqual,
  replacesConnection,
  requestTimeoutInvalid,
  updatePayload,
  withPreset,
} from "./llmSettingsModel";

const hosted: LLMProviderPreset = {
  id: "hosted",
  name: "Hosted service",
  kind: "openai",
  defaultUrl: "https://hosted.example.invalid",
  modelPath: "/v1/models",
  boundary: "external",
};
const custom: LLMProviderPreset = { ...hosted, id: "custom-openai", name: "Custom", defaultUrl: "" };
const ollama: LLMProviderPreset = {
  id: "ollama",
  name: "Ollama",
  kind: "ollama",
  defaultUrl: "",
  modelPath: "/api/tags",
  boundary: "private",
};

const saved: LLMProvider = {
  id: "synthetic-provider",
  presetId: "custom-openai",
  name: "Example LLM",
  kind: "openai",
  baseUrl: "https://first.example.invalid",
  boundary: "external",
  allowSensitive: false,
  enabled: true,
  hasApiKey: true,
  defaultModel: "example-model",
  models: [],
  requestTimeoutSeconds: 600,
};

describe("provider drafts", () => {
  it("creates a provider from its preset, leaving the endpoint to the service default", () => {
    const draft = { ...draftFromPreset(hosted), name: " Example ", apiKey: "synthetic-key" };
    expect(endpointMissing(draft, hosted)).toBe(false);
    expect(createPayload(draft)).toEqual({
      presetId: "hosted",
      kind: "openai",
      name: "Example",
      enabled: true,
      defaultModel: "",
      boundary: "external",
      allowSensitive: false,
      ollamaScope: undefined,
      requestTimeoutSeconds: 600,
      baseUrl: "",
      apiKey: "synthetic-key",
    });
  });

  it("sends the request timeout in seconds and Ollama options only to Ollama", () => {
    const sameMachine = draftFromPreset(ollama);
    expect(sameMachine.ollamaDisableThinking).toBe(true);
    expect(createPayload({ ...sameMachine, requestTimeoutMinutes: "", ollamaContextLength: "8192" })).toMatchObject({
      requestTimeoutSeconds: 0,
      ollamaContextLength: 8192,
      ollamaDisableThinking: true,
    });
    expect(createPayload({ ...sameMachine, ollamaContextLength: "" })).toMatchObject({ ollamaContextLength: 0 });
    expect(updatePayload(draftFromProvider({ ...saved, requestTimeoutSeconds: 1200 }))).toMatchObject({
      requestTimeoutSeconds: 1200,
    });
    expect(updatePayload(draftFromProvider(saved))).not.toHaveProperty("ollamaContextLength");
  });

  it("rejects request settings outside the server bounds", () => {
    const draft = draftFromPreset(ollama);
    expect(requestTimeoutInvalid({ ...draft, requestTimeoutMinutes: "0" })).toBe(true);
    expect(requestTimeoutInvalid({ ...draft, requestTimeoutMinutes: "61" })).toBe(true);
    expect(requestTimeoutInvalid({ ...draft, requestTimeoutMinutes: "" })).toBe(false);
    expect(contextLengthInvalid({ ...draft, ollamaContextLength: "256" })).toBe(true);
    expect(contextLengthInvalid({ ...draft, ollamaContextLength: "4096" })).toBe(false);
    expect(contextLengthInvalid({ ...draftFromPreset(hosted), ollamaContextLength: "256" })).toBe(false);
  });

  it("requires an endpoint only where the server has no address to fall back to", () => {
    expect(endpointMissing(draftFromPreset(custom), custom)).toBe(true);
    expect(endpointMissing({ ...draftFromPreset(custom), baseUrl: "llm.example.invalid" }, custom)).toBe(false);
    const sameMachine = draftFromPreset(ollama);
    expect(endpointMissing(sameMachine, ollama)).toBe(false);
    expect(endpointMissing({ ...sameMachine, ollamaScope: "other_machine" }, ollama)).toBe(true);
  });

  it("sends no endpoint for a same-machine Ollama and starts it on the private boundary", () => {
    const payload = createPayload(draftFromPreset(ollama));
    expect(payload).toMatchObject({ presetId: "ollama", ollamaScope: "local_machine", boundary: "private" });
    expect(payload).not.toHaveProperty("baseUrl");
  });

  it("keeps the typed name and key when the preset choice changes", () => {
    const draft = withPreset({ ...draftFromPreset(hosted), name: "Mine", apiKey: "synthetic-key" }, ollama);
    expect(draft).toMatchObject({ presetId: "ollama", kind: "ollama", name: "Mine", apiKey: "synthetic-key" });
    expect(draft.boundary).toBe("private");
  });

  it("leaves the stored key alone unless a new one is typed or it is cleared", () => {
    const draft = draftFromProvider(saved);
    expect(updatePayload(draft)).not.toHaveProperty("apiKey");
    expect(updatePayload({ ...draft, apiKey: "synthetic-key" })).toMatchObject({ apiKey: "synthetic-key" });
    expect(updatePayload({ ...draft, apiKey: "synthetic-key", clearKey: true })).toMatchObject({ apiKey: "" });
  });

  it("allows sensitive content only on a private boundary", () => {
    const draft = { ...draftFromProvider(saved), allowSensitive: true };
    expect(updatePayload(draft)).toMatchObject({ boundary: "external", allowSensitive: false });
    expect(updatePayload({ ...draft, boundary: "private" })).toMatchObject({ allowSensitive: true });
  });

  it("reports when an edit replaces the connection the stored key belongs to", () => {
    const draft = draftFromProvider(saved);
    expect(replacesConnection(draft)).toBe(false);
    expect(replacesConnection({ ...draft, name: "Renamed", defaultModel: "other-model" })).toBe(false);
    expect(replacesConnection({ ...draft, baseUrl: "https://second.example.invalid" })).toBe(true);
    const sameMachine = draftFromProvider({
      ...saved,
      presetId: "ollama",
      kind: "ollama",
      ollamaScope: "local_machine",
      baseUrl: "http://gateway.example.invalid:11434",
    });
    expect(replacesConnection(sameMachine)).toBe(false);
    expect(replacesConnection({ ...sameMachine, ollamaScope: "other_machine", baseUrl: "" })).toBe(true);
    expect(replacesConnection(draftFromPreset(custom))).toBe(false);
  });
});

describe("policiesEqual", () => {
  const policy: LLMPolicy = {
    alwaysScanAllAges: false,
    tagIds: [1],
    keywords: [{ term: "restricted phrase", fields: ["all"], action: "blocked" }],
  };

  it("ignores rule ids the server assigns and an unset remote lyrics option", () => {
    expect(
      policiesEqual(policy, {
        ...policy,
        remoteLyrics: false,
        keywords: [{ ...policy.keywords[0], id: "synthetic-rule-0" }],
      }),
    ).toBe(true);
  });

  it("detects an edited rule, tag or option", () => {
    expect(policiesEqual(policy, { ...policy, tagIds: [] })).toBe(false);
    expect(policiesEqual(policy, { ...policy, remoteLyrics: true })).toBe(false);
    expect(policiesEqual(policy, { ...policy, keywords: [{ ...policy.keywords[0], fields: ["all", "lyrics"] }] })).toBe(
      false,
    );
  });
});
