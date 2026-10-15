import { describe, expect, it } from "vitest";

import type { ASRPreset, ASRProvider } from "@/lib/api";

import {
  createPayload,
  draftFromPreset,
  draftFromProvider,
  endpointMissing,
  portMissing,
  replacesConnection,
  updatePayload,
} from "./asrSettingsModel";

const localPreset: ASRPreset = {
  id: "local",
  name: "Local deployment",
  defaultUrl: "",
  boundary: "private",
  local: true,
};
const hostedPreset: ASRPreset = {
  id: "openai",
  name: "OpenAI",
  defaultUrl: "https://api.example.invalid",
  boundary: "external",
  local: false,
};

const sameMachine: ASRProvider = {
  id: "asr-1",
  presetId: "local",
  name: "Example service",
  baseUrl: "http://gateway.example.invalid:8000",
  boundary: "private",
  maxContentClass: "sensitive",
  scope: "local_machine",
  port: 8000,
  enabled: true,
  hasApiKey: true,
  enabledModels: ["example-model"],
  defaultModel: "example-model",
  models: [],
};

describe("speech recognition service drafts", () => {
  it("asks a same-machine deployment for a port and never sends an address", () => {
    const draft = draftFromPreset(localPreset);
    expect(draft.scope).toBe("local_machine");
    expect(portMissing(draft)).toBe(true);
    expect(portMissing({ ...draft, port: "70000" })).toBe(true);
    expect(endpointMissing(draft, localPreset)).toBe(false);

    const payload = createPayload({ ...draft, port: "8000", baseUrl: "http://127.0.0.1:8000" });
    expect(payload).toMatchObject({ presetId: "local", scope: "local_machine", port: 8000, boundary: "private" });
    expect(payload).not.toHaveProperty("baseUrl");
  });

  it("asks another machine for its origin", () => {
    const draft = { ...draftFromPreset(localPreset), scope: "other_machine" as const };
    expect(endpointMissing(draft, localPreset)).toBe(true);
    expect(portMissing(draft)).toBe(false);
    expect(updatePayload({ ...draft, baseUrl: " http://192.0.2.10:8000 " })).toMatchObject({
      scope: "other_machine",
      baseUrl: "http://192.0.2.10:8000",
    });
    // A hosted preset falls back to its built-in address.
    expect(endpointMissing(draftFromPreset(hostedPreset), hostedPreset)).toBe(false);
  });

  it("warns that a changed location or port replaces the connection", () => {
    const draft = draftFromProvider(sameMachine);
    expect(draft.baseUrl).toBe("");
    expect(replacesConnection(draft)).toBe(false);
    expect(replacesConnection({ ...draft, port: "8001" })).toBe(true);
    expect(replacesConnection({ ...draft, scope: "other_machine" })).toBe(true);
  });

  it("keeps the receive maximum when the data boundary changes", () => {
    const draft = { ...draftFromProvider(sameMachine), boundary: "external" as const };
    expect(updatePayload(draft).maxContentClass).toBe("sensitive");
  });
});
