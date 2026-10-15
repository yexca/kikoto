import { expect, test, type Page } from "@playwright/test";
import type { LLMLyricsTranslation, LLMPolicy, LLMProvider, LLMTranslation, WorkDetail } from "../../src/lib/api";
import {
  appSettingsFixture,
  authenticatedStateFixture,
  metadataTagFixture,
  mediaItemFixture,
  mediaLocationFixture,
  rolePermissions,
  workDetailFixture,
  type ApiResponse,
} from "./fixtures/api";
import { mockApplication, work } from "./fixtures/player-library";

const provider: LLMProvider = {
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
};
const translation: LLMTranslation = {
  previewId: "synthetic-preview",
  providerId: provider.id,
  providerName: provider.name,
  model: "example-model",
  targetLanguage: "zh-cn",
  assessment: { class: "safe", reason: "no configured rule matched", matches: [] },
  source: { title: "Example original", description: "Original description" },
  translation: { title: "Example translation", description: "Translated description" },
};

async function application(page: Page) {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["system:admin"],
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: authenticatedStateFixture({ role: "admin", permissions: ["system:admin"] }) }),
  );
  await page.route("**/api/settings", (route) => route.fulfill({ json: appSettingsFixture() }));
  // ASR services share the LLM settings tab.
  await page.route("**/api/asr/providers", (route) =>
    route.fulfill({
      json: { providers: [], presets: [], hostAddress: "" } satisfies ApiResponse<"listASRProviders">,
    }),
  );
}
async function openTranslation(page: Page, detailOverrides: Partial<WorkDetail> = {}) {
  await application(page);
  await page.route(/\/api\/works\/(?:1|RJ00000000)(?:\?includeMedia=false)?$/, (route) =>
    route.fulfill({
      json: workDetailFixture(
        { ...work, title: "Example original", ageRating: "general" },
        { description: "Original description", manualOverrides: {}, ...detailOverrides },
      ),
    }),
  );
  await page.route("**/api/works/1/cover-candidates", (route) =>
    route.fulfill({ json: { candidates: [], providerCoverUrl: "" } satisfies ApiResponse<"listWorkCoverCandidates"> }),
  );
  await page.route("**/api/works/1/metadata-tags", (route) =>
    route.fulfill({
      json: { tags: [], inheritedTags: [], overrides: [] } satisfies ApiResponse<"getWorkMetadataTags">,
    }),
  );
  await page.route("**/api/llm/translation-models", (route) =>
    route.fulfill({
      json: [
        {
          id: provider.id,
          name: provider.name,
          defaultModel: provider.defaultModel,
          boundary: provider.boundary,
          allowSensitive: false,
        },
      ] satisfies ApiResponse<"listTranslationModels">,
    }),
  );
  await page.route("**/api/works/1/llm-reviews", (route) =>
    route.fulfill({ json: [] satisfies ApiResponse<"listTranslationReviews"> }),
  );
  await page.route("**/api/works/1/llm-translations", (route) =>
    route.fulfill({ json: { current: [], history: [] } satisfies ApiResponse<"listTranslations"> }),
  );
  await page.goto("/RJ00000000");
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Edit metadata", exact: true })
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Translate with LLM", exact: true });
}

test("LLM settings save connection drafts before discovery and edit structured content rules", async ({ page }) => {
  await application(page);
  let current = { ...provider };
  let policy: LLMPolicy = { alwaysScanAllAges: false, tagIds: [], keywords: [] };
  const writes: Record<string, unknown>[] = [];
  const calls: string[] = [];
  await page.route("**/api/llm/providers", (route) =>
    route.fulfill({
      json: {
        providers: [current],
        presets: [
          {
            id: "custom-openai",
            name: "Custom OpenAI-compatible",
            kind: "openai",
            defaultUrl: "",
            modelPath: "/v1/models",
            boundary: "external",
          },
        ],
        policy,
        noticeAccepted: true,
      } satisfies ApiResponse<"listProviders">,
    }),
  );
  await page.route("**/api/llm/providers/synthetic-provider", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(body);
    calls.push("save");
    current = {
      ...current,
      ...body,
      hasApiKey: body.apiKey === undefined ? current.hasApiKey : body.apiKey !== "",
      models: [],
    };
    return route.fulfill({ json: current });
  });
  await page.route("**/api/llm/providers/synthetic-provider/fetch-models", (route) => {
    calls.push("fetch");
    return route.fulfill({ status: 502, json: { error: "Models could not be fetched." } });
  });
  const tag = metadataTagFixture({ id: 1, displayName: "Example risk tag" });
  await page.route("**/api/metadata/tags?*", (route) =>
    route.fulfill({ json: { tags: [tag], total: 1, page: 1, pageSize: 20, pendingWorkCount: 0 } }),
  );
  await page.route("**/api/metadata/tags/1", (route) => route.fulfill({ json: tag }));
  await page.route("**/api/llm/policy", (route) => {
    policy = route.request().postDataJSON() as LLMPolicy;
    policy.keywords = policy.keywords.map((rule, index) => ({ ...rule, id: rule.id ?? "synthetic-rule-" + index }));
    return route.fulfill({ json: policy });
  });
  await page.goto("/settings?tab=llm");
  await page.getByRole("button", { name: "Edit Example LLM", exact: true }).click();
  const connection = page.getByRole("dialog", { name: "Edit LLM provider", exact: true });
  await connection.getByLabel("Endpoint", { exact: true }).fill("https://second.example.invalid");
  await connection.getByLabel("Default model", { exact: true }).fill("manual-model");
  await connection.getByLabel("Clear stored API key", { exact: true }).check();
  await connection.getByRole("button", { name: "Fetch models", exact: true }).click();
  await expect.poll(() => calls).toEqual(["save", "fetch"]);
  expect(writes[0]).toMatchObject({
    baseUrl: "https://second.example.invalid",
    defaultModel: "manual-model",
    apiKey: "",
  });
  await expect(connection.getByLabel("Default model", { exact: true })).toHaveValue("manual-model");
  await connection
    .getByRole("radiogroup", { name: "Data boundary", exact: true })
    .getByRole("radio", { name: "Private", exact: true })
    .click();
  await connection.getByRole("switch", { name: "Allow sensitive content", exact: true }).check();
  await connection.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ boundary: "private", allowSensitive: true });
  await expect(connection).toBeHidden();
  const rules = page.getByRole("region", { name: "Content safety policy", exact: true });
  await rules.getByRole("combobox", { name: "Sensitive metadata tags", exact: true }).fill("Example");
  await rules.getByRole("option", { name: "Example risk tag", exact: true }).click();
  await rules.getByRole("button", { name: "Add keyword rule", exact: true }).click();
  await rules.getByLabel("Keyword for rule 1", { exact: true }).fill("restricted phrase");
  await rules.getByLabel("Action for rule 1", { exact: true }).selectOption("blocked");
  await rules.getByRole("checkbox", { name: "Lyrics", exact: true }).check();
  await rules.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => policy.tagIds).toEqual([1]);
  expect(policy.keywords[0]).toMatchObject({ term: "restricted phrase", fields: ["all", "lyrics"], action: "blocked" });
  expect(policy.keywords[0].id).toBeTruthy();
});

test("LLM settings add a provider in a dialog and confirm before deleting it", async ({ page }) => {
  await application(page);
  let providers: LLMProvider[] = [];
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  await page.route("**/api/llm/providers", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      created.push(body);
      const next: LLMProvider = {
        ...provider,
        id: "synthetic-created",
        name: "Custom OpenAI-compatible",
        baseUrl: String(body.baseUrl),
        hasApiKey: Boolean(body.apiKey),
        defaultModel: "",
      };
      providers = [next];
      return route.fulfill({ json: next });
    }
    return route.fulfill({
      json: {
        providers,
        presets: [
          {
            id: "hosted",
            name: "Hosted service",
            kind: "openai",
            defaultUrl: "https://hosted.example.invalid",
            modelPath: "/v1/models",
            boundary: "external",
          },
          {
            id: "custom-openai",
            name: "Custom OpenAI-compatible",
            kind: "openai",
            defaultUrl: "",
            modelPath: "/v1/models",
            boundary: "external",
          },
        ],
        policy: { alwaysScanAllAges: false, tagIds: [], keywords: [] },
        noticeAccepted: true,
      } satisfies ApiResponse<"listProviders">,
    });
  });
  await page.route("**/api/llm/providers/synthetic-created", (route) => {
    if (route.request().method() === "DELETE") {
      providers = [];
      return route.fulfill({ json: { ok: true } });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    updates.push(body);
    providers = [{ ...providers[0], ...body }];
    return route.fulfill({ json: providers[0] });
  });

  await page.goto("/settings?tab=llm");
  const list = page.getByRole("region", { name: "LLM providers", exact: true });
  await expect(list.getByText("No LLM providers configured.", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add provider", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add LLM provider", exact: true });
  await dialog.getByRole("radio", { name: "Custom OpenAI-compatible", exact: true }).click();
  await dialog.getByRole("button", { name: "Add provider", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter the endpoint for this provider.");
  expect(created).toEqual([]);
  await dialog.getByLabel("Endpoint", { exact: true }).fill("https://llm.example.invalid");
  await dialog.getByLabel("API key", { exact: true }).fill("synthetic-key");
  await dialog.getByRole("button", { name: "Add provider", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(created).toEqual([
    expect.objectContaining({
      presetId: "custom-openai",
      kind: "openai",
      baseUrl: "https://llm.example.invalid",
      apiKey: "synthetic-key",
      enabled: true,
    }),
  ]);

  await list.getByRole("switch", { name: "Enable Custom OpenAI-compatible", exact: true }).uncheck();
  await expect.poll(() => updates).toEqual([{ enabled: false }]);

  await list.getByRole("button", { name: "Delete Custom OpenAI-compatible", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete LLM provider?", exact: true });
  await expect(list.getByRole("button", { name: "Edit Custom OpenAI-compatible", exact: true })).toBeVisible();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(list.getByText("No LLM providers configured.", { exact: true })).toBeVisible();
});

test("LLM & ASR settings list both services above their shared content safety policy", async ({ page }) => {
  await application(page);
  await page.route("**/api/llm/providers", (route) =>
    route.fulfill({
      json: {
        providers: [provider],
        presets: [],
        policy: { alwaysScanAllAges: false, tagIds: [], keywords: [] },
        noticeAccepted: true,
      } satisfies ApiResponse<"listProviders">,
    }),
  );

  // The former ASR tab id opens the shared tab.
  await page.goto("/settings?tab=asr");
  await expect(page.getByRole("tab", { name: "LLM & ASR", exact: true })).toHaveAttribute("aria-selected", "true");
  const sections = ["LLM providers", "ASR services", "Content safety policy"].map((name) =>
    page.getByRole("region", { name, exact: true }),
  );
  for (const section of sections) await expect(section).toBeVisible();
  const tops = await Promise.all(sections.map(async (section) => (await section.boundingBox())?.y ?? 0));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
});

test("LLM & ASR settings stay locked until the external service notice is accepted", async ({ page }) => {
  await application(page);
  let accepted = 0;
  await page.route("**/api/llm/providers", (route) =>
    route.fulfill({
      json: {
        providers: [],
        presets: [
          {
            id: "custom-openai",
            name: "Custom OpenAI-compatible",
            kind: "openai",
            defaultUrl: "",
            modelPath: "/v1/models",
            boundary: "external",
          },
        ],
        policy: { alwaysScanAllAges: false, tagIds: [], keywords: [] },
        noticeAccepted: false,
      } satisfies ApiResponse<"listProviders">,
    }),
  );
  await page.route("**/api/llm/notice-acceptance", (route) => {
    accepted += 1;
    return route.fulfill({ json: { noticeAccepted: true } });
  });

  await page.goto("/settings?tab=llm");
  const notice = page.getByRole("region", { name: "Before you connect external services", exact: true });
  await expect(notice).toBeVisible();
  // The settings behind the notice are out of reach until it is accepted.
  await expect(page.getByRole("button", { name: "Add provider", exact: true })).toHaveCount(0);
  const accept = notice.getByRole("button", { name: "Accept and continue", exact: true });
  await expect(accept).toBeDisabled();
  await notice.getByRole("checkbox", { name: "I have read and accept this notice", exact: true }).click();
  await accept.click();

  await expect(notice).toBeHidden();
  expect(accepted).toBe(1);
  await expect(page.getByRole("button", { name: "Add provider", exact: true })).toBeEnabled();
});

test("LLM dialog prechecks without translation, uses minimal models and confirms the preview", async ({ page }) => {
  let administratorReads = 0;
  let requests = 0;
  let applied: unknown;
  await page.route("**/api/llm/providers", (route) => {
    administratorReads++;
    return route.fulfill({ status: 403, json: { error: "permission denied" } });
  });
  const dialog = await openTranslation(page);
  await page.route("**/api/works/1/llm-precheck", (route) =>
    route.fulfill({
      json: {
        assessment: translation.assessment,
        checkedFields: ["title", "description", "tags"],
        sentFields: [],
      } satisfies ApiResponse<"precheckWork">,
    }),
  );
  await page.route("**/api/works/1/llm-translate", (route) => {
    requests++;
    expect(route.request().postDataJSON()).toMatchObject({ targetLanguage: "zh-cn", fields: ["title", "description"] });
    return route.fulfill({ json: translation });
  });
  await page.route("**/api/works/1/llm-translation", (route) => {
    applied = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await dialog.getByRole("button", { name: "Check content without sending", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("safe");
  expect(requests).toBe(0);
  await dialog.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(dialog.getByText("Example translation", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Use translation", exact: true }).click();
  await expect.poll(() => applied).toEqual({ previewId: "synthetic-preview" });
  await expect(dialog).toHaveCount(0);
  expect(administratorReads).toBe(0);
});

test("LLM background review recovers a durable preview and rejects it explicitly", async ({ page }) => {
  const dialog = await openTranslation(page);
  let queued: unknown;
  let rejected = 0;
  await page.route("**/api/llm/translation-runs", (route) => {
    queued = route.request().postDataJSON();
    return route.fulfill({
      json: {
        runs: [{ workId: 1, runId: 1, state: "ready", deduplicated: false }],
      } satisfies ApiResponse<"queueTranslations">,
    });
  });
  await dialog.getByRole("button", { name: "Queue background translation", exact: true }).click();
  await expect.poll(() => queued).toMatchObject({ workCodes: ["RJ00000000"], fields: ["title", "description"] });
  await expect(dialog.getByRole("link", { name: "Activity #1" })).toBeVisible();
  await page.route("**/api/works/1/llm-reviews", (route) =>
    route.fulfill({
      json: [
        { ...translation, status: "proposed", fields: ["title", "description"], expiresAt: 1791907200 },
      ] satisfies ApiResponse<"listTranslationReviews">,
    }),
  );
  await page.route("**/api/works/1/llm-previews/synthetic-preview", (route) => {
    rejected++;
    return route.fulfill({ json: { ok: true } });
  });
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await dialog.getByRole("button", { name: "Review", exact: true }).click();
  await expect(dialog.getByText("Translated description", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect.poll(() => rejected).toBe(1);
});

test("Manage lyrics translates a lyrics file for its track and adds the reviewed result @desktop", async ({ page }) => {
  const localFile = (id: number, kind: string, name: string) =>
    mediaItemFixture({
      id,
      kind,
      title: name,
      locations: [mediaLocationFixture({ id, path: `${work.primaryCode}/${name}`, availability: "available" })],
    });
  await mockApplication(
    page,
    undefined,
    false,
    1,
    0,
    [localFile(1, "audio", "track.mp3"), localFile(2, "text", "track.mp3.vtt")],
    undefined,
    {
      work: {
        ...work,
        ageRating: "general",
        sourcePresence: [
          {
            type: "local",
            availability: "available",
            fileSourceId: 1,
            fileSourceCode: "local",
            fileSourceName: "Local",
            sourceUrl: work.primaryCode,
          },
        ],
      },
      detailLocalFolders: [
        {
          id: 104,
          workId: work.id,
          fileSourceId: 1,
          rootPath: work.primaryCode,
          role: "external",
          state: "active",
          primary: true,
        },
      ],
      authenticated: true,
      permissions: rolePermissions.admin,
    },
  );
  await page.route("**/api/llm/translation-models", (route) =>
    route.fulfill({
      json: [
        {
          id: provider.id,
          name: provider.name,
          defaultModel: provider.defaultModel,
          boundary: provider.boundary,
          allowSensitive: false,
        },
      ] satisfies ApiResponse<"listTranslationModels">,
    }),
  );
  let translations: LLMLyricsTranslation[] = [];
  await page.route(`**/api/works/${work.id}/llm-lyrics-translations`, (route) =>
    route.fulfill({ json: translations satisfies ApiResponse<"listLyricsTranslations"> }),
  );
  const queued: Record<string, unknown>[] = [];
  await page.route("**/api/llm/translation-runs", (route) => {
    queued.push(route.request().postDataJSON() as Record<string, unknown>);
    translations = [
      {
        taskId: 7,
        runId: 41,
        audioMediaItemId: 1,
        lyricsLocationId: 2,
        targetLanguage: "en-us",
        providerName: provider.name,
        model: "example-model",
        state: "ready",
        previewId: "synthetic-preview",
        updatedAt: "2026-01-01 00:00:00",
      },
    ];
    return route.fulfill({
      status: 202,
      json: { runs: [{ workId: work.id, runId: 41, state: "pending", deduplicated: false }] },
    });
  });
  await page.route(`**/api/works/${work.id}/llm-previews/synthetic-preview/lyrics`, (route) =>
    route.fulfill({ body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst translated line\n" }),
  );
  const prechecks: unknown[] = [];
  await page.route(`**/api/works/${work.id}/llm-precheck`, (route) => {
    prechecks.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        assessment: { class: "sensitive", reason: "restricted age rating", matches: [] },
        checkedFields: ["title", "description", "tags", "lyrics"],
        sentFields: [],
      } satisfies ApiResponse<"precheckWork">,
    });
  });
  const applied: unknown[] = [];
  await page.route(`**/api/works/${work.id}/llm-translation`, (route) => {
    applied.push(route.request().postDataJSON());
    translations = [{ ...translations[0], state: "accepted", previewId: undefined }];
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("button", { name: "Manage lyrics", exact: true })
    .click();
  const lyrics = page.getByRole("dialog", { name: "Manage lyrics" });
  await lyrics.getByRole("tab", { name: "Translate" }).click();

  // The file's own track is the destination until another is chosen.
  await expect(lyrics.getByRole("combobox", { name: "Lyrics file" })).toContainText("track.mp3.vtt");
  await expect(lyrics.getByRole("combobox", { name: "Track", exact: true })).toContainText("track.mp3");

  // The content rating is checked only when asked, for the chosen lyrics file and track.
  expect(prechecks).toHaveLength(0);
  await lyrics.getByRole("button", { name: "Check rating" }).click();
  await expect(lyrics.getByText("Example LLM cannot receive this content.", { exact: false })).toBeVisible();
  expect(prechecks).toEqual([{ fields: ["lyrics"], lyricsLocationId: 2, audioMediaItemId: 1 }]);
  await lyrics.getByRole("combobox", { name: "LLM provider" }).click();
  const option = page.getByRole("option", { name: /Example LLM/ });
  await expect(option).toContainText("Not for this content");
  await option.click();

  await lyrics.getByRole("button", { name: "Translate", exact: true }).click();
  await expect.poll(() => queued).toHaveLength(1);
  expect(queued[0]).toEqual({
    workCodes: [work.primaryCode],
    providerId: provider.id,
    targetLanguage: "en-us",
    fields: ["lyrics"],
    lyricsLocationId: 2,
    audioMediaItemId: 1,
  });

  await expect(lyrics.getByText("Awaiting review", { exact: true })).toBeVisible();
  await lyrics.getByRole("button", { name: "Preview the translation for track.mp3" }).click();
  await expect(lyrics.getByText("First translated line")).toBeVisible();
  await lyrics.getByRole("button", { name: "Add to lyrics" }).click();
  await expect.poll(() => applied).toEqual([{ previewId: "synthetic-preview" }]);
  await expect(lyrics.getByText("Added to lyrics", { exact: true })).toBeVisible();
});
