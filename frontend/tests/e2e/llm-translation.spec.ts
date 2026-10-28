import { expect, test, type Page } from "@playwright/test";
import type { LLMPolicy, LLMProvider, TranslationItem, TranslationPlan } from "../../src/lib/api";
import {
  appSettingsFixture,
  authenticatedStateFixture,
  metadataTagFixture,
  mediaItemFixture,
  mediaLocationFixture,
  rolePermissions,
  runtimeSettingsFixture,
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
  maxContentClass: "safe",
  enabled: true,
  hasApiKey: true,
  enabledModels: ["example-model"],
  defaultModel: "example-model",
  models: [],
  requestTimeoutSeconds: 600,
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
test("LLM settings save connection drafts before discovery and edit structured content rules", async ({ page }) => {
  await application(page);
  let current = { ...provider };
  let policy: LLMPolicy = { alwaysScanAllAges: false, tagRules: [], keywords: [] };
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
        hostAddress: "",
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
    return route.fulfill({ json: policy });
  });
  await page.goto("/settings?tab=llm");
  await page.getByRole("button", { name: "Edit Example LLM", exact: true }).click();
  const connection = page.getByRole("dialog", { name: "Edit LLM provider", exact: true });
  await connection.getByLabel("Endpoint", { exact: true }).fill("https://second.example.invalid");
  await connection.getByLabel("Model ID", { exact: true }).fill("manual-model");
  await connection.getByRole("button", { name: "Add", exact: true }).click();
  await connection.getByRole("radio", { name: "Use manual-model by default", exact: true }).check();
  await connection.getByLabel("Clear stored API key", { exact: true }).check();
  await connection.getByRole("button", { name: "Fetch models", exact: true }).click();
  await expect.poll(() => calls).toEqual(["save", "fetch"]);
  expect(writes[0]).toMatchObject({
    baseUrl: "https://second.example.invalid",
    enabledModels: ["example-model", "manual-model"],
    defaultModel: "manual-model",
    apiKey: "",
  });
  await expect(connection.getByRole("radio", { name: "Use manual-model by default", exact: true })).toBeChecked();
  await connection.getByRole("combobox", { name: "Maximum content level", exact: true }).selectOption("sensitive");
  await connection.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ boundary: "external", maxContentClass: "sensitive" });
  await expect(connection).toBeHidden();
  const rules = page.getByRole("region", { name: "Content safety policy", exact: true });
  const textOnly = rules.getByRole("switch", { name: "LLM translation checks selected text only", exact: true });
  await expect(textOnly).not.toBeChecked();
  await textOnly.click();
  await expect(rules.getByText(/Configure keywords and levels for every language in the source/)).toBeVisible();
  await rules.getByRole("combobox", { name: "Metadata tag rules", exact: true }).fill("Example");
  await rules.getByRole("option", { name: "Example risk tag", exact: true }).click();
  await rules
    .getByRole("combobox", { name: "Action for tag Example risk tag", exact: true })
    .selectOption("restricted");
  await rules.getByRole("button", { name: "Add keyword rule", exact: true }).click();
  await rules.getByLabel("Keyword for rule 1", { exact: true }).fill("restricted phrase");
  await rules.getByLabel("Action for rule 1", { exact: true }).selectOption("blocked");
  await rules.getByRole("checkbox", { name: "Lyrics", exact: true }).check();
  await rules.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => policy.tagRules).toEqual([{ tagId: 1, action: "restricted" }]);
  expect(policy.llmTranslationTextOnly).toBe(true);
  expect(policy.keywords[0]).toMatchObject({ term: "restricted phrase", fields: ["all", "lyrics"], action: "blocked" });
  expect(policy.keywords[0].id).toMatch(/^rule-[0-9a-f]{32}$/);
  await expect(rules.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
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
        enabledModels: [],
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
        policy: { alwaysScanAllAges: false, tagRules: [], keywords: [] },
        noticeAccepted: true,
        hostAddress: "",
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

test("ASR & LLM settings list speech services before LLM providers, then the shared policy and AI lyrics", async ({
  page,
}) => {
  await application(page);
  const attribution: unknown[] = [];
  await page.route("**/api/llm/lyrics-attribution", (route) => {
    if (route.request().method() === "PUT") {
      attribution.push(route.request().postDataJSON());
      return route.fulfill({ json: { enabled: false } });
    }
    return route.fulfill({ json: { enabled: true } });
  });
  await page.route("**/api/llm/providers", (route) =>
    route.fulfill({
      json: {
        providers: [provider],
        presets: [],
        policy: { alwaysScanAllAges: false, tagRules: [], keywords: [] },
        noticeAccepted: true,
        hostAddress: "",
      } satisfies ApiResponse<"listProviders">,
    }),
  );

  // The former ASR tab id opens the shared tab.
  await page.goto("/settings?tab=asr");
  await expect(page.getByRole("tab", { name: "ASR & LLM", exact: true })).toHaveAttribute("aria-selected", "true");
  const sections = ["ASR services", "LLM providers", "Content safety policy", "AI lyrics"].map((name) =>
    page.getByRole("region", { name, exact: true }),
  );
  for (const section of sections) await expect(section).toBeVisible();
  const tops = await Promise.all(sections.map(async (section) => (await section.boundingBox())?.y ?? 0));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
  await page.getByRole("switch", { name: "Name the models in AI-made lyrics", exact: true }).click();
  await expect.poll(() => attribution).toEqual([{ enabled: false }]);
});

test("ASR & LLM settings stay locked until the external service notice is accepted", async ({ page }) => {
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
        policy: { alwaysScanAllAges: false, tagRules: [], keywords: [] },
        noticeAccepted: false,
        hostAddress: "",
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

function translationPlanCategory(missing: number, extra: Partial<TranslationPlan["languages"][number]["title"]> = {}) {
  return { missing, active: 0, characters: missing * 10, ...extra };
}

function reviewItem(overrides: Partial<TranslationItem>): TranslationItem {
  return {
    id: 1,
    runId: 41,
    workId: work.id,
    workCode: work.primaryCode,
    workTitle: work.title,
    language: "en-us",
    category: "title",
    subject: "",
    state: "ready",
    label: "",
    source: "Example original",
    result: "Example translation",
    model: "example-model",
    progress: 0,
    chunks: 0,
    requestedBy: "synthetic-admin",
    updatedAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

test("Translate with AI sends only what each language lacks and shows what it wrote @desktop", async ({ page }) => {
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
      authenticated: true,
      permissions: rolePermissions.admin,
    },
  );
  await page.route("**/api/llm/translation-models?*", (route) =>
    route.fulfill({
      json: [
        {
          id: provider.id,
          name: provider.name,
          defaultModel: provider.defaultModel,
          models: ["example-model"],
          boundary: provider.boundary,
          maxContentClass: "sensitive",
        },
      ] satisfies ApiResponse<"listTranslationModels">,
    }),
  );
  await page.route("**/api/asr/services", (route) =>
    route.fulfill({ json: [] satisfies ApiResponse<"listASRServices"> }),
  );
  const requests: unknown[] = [];
  await page.route(`**/api/works/${work.id}/ai-translation*`, (route) => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { runId: 41, items: 5, skipped: [] } });
    }
    const languages = new URL(route.request().url()).searchParams.get("languages")!.split(",");
    return route.fulfill({
      json: {
        workId: work.id,
        originLanguage: "ja-jp",
        permissions: { metadata: true, files: true, lyrics: true },
        languages: languages.map((language) => ({
          language,
          title: translationPlanCategory(1),
          description: translationPlanCategory(0, { active: 1 }),
          tags: translationPlanCategory(2, { affectedWorks: 3 }),
          files: translationPlanCategory(1),
          lyrics: [],
        })),
        attributionEnabled: true,
        autoAccept: true,
      } satisfies ApiResponse<"translationPlan">,
    });
  });
  let applied: TranslationItem[] = [];
  await page.route("**/api/translation/items?*", (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    return route.fulfill({ json: { items: view === "history" ? applied : [] } });
  });

  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("button", { name: "Translate with AI", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Translate with AI" });

  // Each category counts what the chosen language lacks; the shared tag names name the works they affect.
  await expect(dialog.getByText("Affects 3 works", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1 in progress", { exact: true })).toBeVisible();
  // The track's name-matched fallback lyrics are translated into the missing language.
  await dialog.getByRole("button", { name: "Translate 5 items", exact: true }).click();
  await expect.poll(() => requests).toHaveLength(1);
  expect(requests[0]).toEqual({
    languages: ["en-us"],
    categories: ["title", "description", "tags", "files"],
    providerId: provider.id,
    model: "example-model",
    lyrics: [{ audioMediaItemId: 1, targetLanguage: "en-us", lyricsLocationId: 2 }],
  });

  // Each finished item applies at once; the results name what it wrote.
  applied = [
    reviewItem({
      id: 11,
      state: "accepted",
      category: "lyrics",
      subject: "1",
      label: "track.mp3",
      appliedPath: `${work.primaryCode}/lyrics_kikoto/en/track.mp3.vtt`,
    }),
  ];
  await dialog.getByRole("tab", { name: "Results" }).click();
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  const appliedResults = dialog.getByRole("region", { name: "Applied" });
  await expect(
    appliedResults.getByText(`${work.primaryCode}/lyrics_kikoto/en/track.mp3.vtt`, { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
});

test("The Translation page leaves out review while auto-accept is on and lists what was written", async ({ page }) => {
  await application(page);
  await page.route("**/api/translation/runs?*", (route) =>
    route.fulfill({
      json: {
        runs: [],
        counts: { active: 0, queued: 0, review: 0, attention: 0 },
        autoAccept: true,
      } satisfies ApiResponse<"listTranslationRuns">,
    }),
  );
  await page.route("**/api/translation/items?*", (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    const items = view === "history" ? [reviewItem({ id: 4, state: "accepted", language: "ko-kr" })] : [];
    return route.fulfill({ json: { items } satisfies ApiResponse<"listTranslationItems"> });
  });

  await page.goto("/translation");
  const views = page.getByRole("tablist", { name: "Translation views", exact: true });
  await expect(views.getByRole("tab")).toHaveText(["In progress", "Stopped", "History", "Coverage"]);
  await expect(views.getByRole("tab", { name: "In progress" })).toHaveAttribute("aria-selected", "true");
  await views.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("Example translation", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: work.primaryCode, exact: true })).toHaveAttribute(
    "href",
    `/${work.primaryCode}`,
  );
});

test("With auto-accept off, the Translation page reviews items across works and resends an uncertain one", async ({
  page,
}) => {
  await application(page);
  await page.route("**/api/translation/runs?*", (route) =>
    route.fulfill({
      json: {
        runs: [],
        counts: { active: 0, queued: 0, review: 2, attention: 1 },
        autoAccept: false,
      } satisfies ApiResponse<"listTranslationRuns">,
    }),
  );
  await page.route("**/api/translation/items?*", (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    const items =
      view === "review"
        ? [
            reviewItem({ id: 1, language: "zh-cn" }),
            reviewItem({
              id: 2,
              language: "zh-cn",
              category: "tag",
              subject: "7",
              source: "Example tag",
              result: "示例标签",
              affectedWorks: 3,
            }),
          ]
        : view === "attention"
          ? [reviewItem({ id: 3, state: "uncertain", failureCode: "upstream_result_unknown", category: "description" })]
          : [];
    return route.fulfill({ json: { items } satisfies ApiResponse<"listTranslationItems"> });
  });
  const accepted: unknown[] = [];
  await page.route("**/api/translation/items/accept", (route) => {
    accepted.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        results: [
          { id: 1, ok: true },
          { id: 2, ok: true },
        ],
      },
    });
  });
  const resent: unknown[] = [];
  await page.route("**/api/translation/items/resend", (route) => {
    resent.push(route.request().postDataJSON());
    return route.fulfill({ json: { results: [{ id: 3, ok: true }] } });
  });

  await page.goto("/translation");
  await expect(page.getByText("Shown on 3 works", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Accept all 2", exact: true }).click();
  await expect.poll(() => accepted).toEqual([{ ids: [1, 2] }]);

  await page.getByRole("tab", { name: /^Stopped/ }).click();
  await expect(page.getByText("The request was sent but its result is unknown.", { exact: true })).toBeVisible();
  // An uncertain request may already have been charged, so sending it again asks first.
  await page.getByRole("button", { name: "Send again", exact: true }).click();
  expect(resent).toHaveLength(0);
  await page.getByRole("button", { name: "Send again anyway", exact: true }).click();
  await expect.poll(() => resent).toEqual([{ ids: [3], acknowledgeUncertain: true }]);
});

test("Manage lyrics transcribes from the audio language with a model that decides the lyrics language @desktop", async ({
  page,
}) => {
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
    [
      localFile(1, "audio", "01.mp3"),
      localFile(2, "audio", "02.mp3"),
      localFile(3, "audio", "03.mp3"),
      localFile(4, "text", "03.mp3.vtt"),
    ],
    undefined,
    { work: { ...work, ageRating: "general" }, authenticated: true, permissions: rolePermissions.admin },
  );
  await page.route("**/api/asr/services", (route) =>
    route.fulfill({
      json: [
        {
          id: "synthetic-asr",
          name: "Example ASR",
          defaultModel: "example-asr",
          models: ["example-asr", "example-translating-asr", "example-hosted-asr"],
          capabilities: {
            "example-asr": { kind: "transcribe", languages: ["ja-jp"] },
            "example-translating-asr": { kind: "translate", translation: { source: "ja-jp", target: "zh-cn" } },
          },
          boundary: "external",
          maxContentClass: "sensitive",
        },
      ] satisfies ApiResponse<"listASRServices">,
    }),
  );
  const created: unknown[] = [];
  await page.route(`**/api/works/${work.id}/asr-transcriptions`, (route) => {
    if (route.request().method() === "POST") {
      created.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: { id: `synthetic-${created.length}`, runId: 50 + created.length, state: "pending", deduplicated: false },
      });
    }
    return route.fulfill({
      json: { transcriptions: [], originLanguage: "ja-jp" } satisfies ApiResponse<"listASRTranscriptions">,
    });
  });

  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("button", { name: "Manage lyrics", exact: true })
    .click();
  const lyrics = page.getByRole("dialog", { name: "Manage lyrics" });
  await lyrics.getByRole("tab", { name: "Transcribe" }).click();

  // Only the tracks without lyrics are listed until another filter is chosen.
  await expect(lyrics.getByRole("checkbox", { name: "Select 01.mp3" })).toBeVisible();
  await expect(lyrics.getByRole("checkbox", { name: "Select 03.mp3" })).toHaveCount(0);
  await lyrics.getByRole("checkbox", { name: "Select all listed tracks" }).click();

  // The audio language starts as the work's original language, and a model that transcribes it writes it.
  await expect(lyrics.getByRole("combobox", { name: "Audio language" })).toContainText("Japanese");
  await expect(lyrics.getByRole("combobox", { name: "Model" })).toContainText("Example ASR · example-asr");
  const lyricsLanguage = lyrics.getByRole("combobox", { name: "Lyrics language" });
  await expect(lyricsLanguage).toContainText("Japanese");
  await expect(lyricsLanguage).toBeDisabled();
  await lyrics.getByRole("button", { name: "Transcribe 2", exact: true }).click();
  await expect.poll(() => created).toHaveLength(2);
  const request = (audioMediaItemId: number, model: string, language: string, audioLanguage = "ja-jp") => ({
    audioMediaItemId,
    providerId: "synthetic-asr",
    model,
    language,
    audioLanguage,
  });
  expect(created).toEqual([request(1, "example-asr", "ja-jp"), request(2, "example-asr", "ja-jp")]);

  // A translating model names its direction and fixes the lyrics language to it.
  await lyrics.getByRole("checkbox", { name: "Select all listed tracks" }).click();
  await lyrics.getByRole("combobox", { name: "Model" }).click();
  await page
    .getByRole("option", { name: "Example ASR · example-translating-asr (Japanese → Simplified Chinese)" })
    .click();
  await expect(lyricsLanguage).toContainText("Simplified Chinese");
  await expect(lyricsLanguage).toBeDisabled();
  await lyrics.getByRole("button", { name: "Transcribe 2", exact: true }).click();
  await expect.poll(() => created).toHaveLength(4);
  expect(created.slice(2)).toEqual([
    request(1, "example-translating-asr", "zh-cn"),
    request(2, "example-translating-asr", "zh-cn"),
  ]);

  // English audio leaves only the model whose languages are unknown; its lyrics language can be chosen.
  await lyrics.getByRole("checkbox", { name: "Select all listed tracks" }).click();
  await lyrics.getByRole("combobox", { name: "Audio language" }).click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(lyrics.getByRole("combobox", { name: "Model" })).toContainText("Example ASR · example-hosted-asr");
  await expect(lyrics.getByText(/does not say which languages its model writes/)).toBeVisible();
  await expect(lyricsLanguage).toContainText("English");
  await lyricsLanguage.click();
  await page.getByRole("option", { name: "Korean" }).click();
  await lyrics.getByRole("button", { name: "Transcribe 2", exact: true }).click();
  await expect.poll(() => created).toHaveLength(6);
  expect(created.slice(4)).toEqual([
    request(1, "example-hosted-asr", "ko-kr", "en-us"),
    request(2, "example-hosted-asr", "ko-kr", "en-us"),
  ]);

  await lyrics.getByRole("tab", { name: /^All tracks/ }).click();
  await expect(lyrics.getByRole("checkbox", { name: "Select 03.mp3" })).toBeVisible();
});

test("Demo shows sample transcriptions in Manage lyrics with every action off @desktop", async ({ page }) => {
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
    [
      localFile(1, "audio", "01.mp3"),
      localFile(2, "audio", "02.mp3"),
      localFile(3, "audio", "03.mp3"),
      localFile(4, "text", "03.mp3.vtt"),
    ],
    undefined,
    { work: { ...work, ageRating: "general" }, authenticated: true, permissions: ["library:read"] },
  );
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: runtimeSettingsFixture({ mode: "demo", demoMode: true }) }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "__demo__",
        role: "user",
        permissions: ["library:read"],
        demoMode: true,
      }),
    }),
  );
  // Demo contacts no speech recognition or LLM endpoint.
  const serviceRequests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (/\/(asr|llm)\/|\/(asr|llm)-/.test(pathname)) serviceRequests.push(pathname);
  });

  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("button", { name: "Manage lyrics", exact: true })
    .click();
  const lyrics = page.getByRole("dialog", { name: "Manage lyrics" });

  await lyrics.getByRole("tab", { name: "Transcribe" }).click();
  await expect(lyrics.getByText(/these transcriptions are samples/)).toBeVisible();
  await lyrics.getByRole("button", { name: "Preview the transcription of 01.mp3" }).click();
  await expect(lyrics.getByText("Sample line 1. Demo did not transcribe this audio.")).toBeVisible();
  await expect(lyrics.getByRole("button", { name: "Add to lyrics" })).toBeDisabled();
  await expect(lyrics.getByRole("button", { name: "Check rating" })).toBeDisabled();
  await lyrics.getByRole("checkbox", { name: "Select 02.mp3" }).click();
  await expect(lyrics.getByRole("combobox", { name: "Model" })).toContainText("Example speech service");
  await expect(lyrics.getByRole("button", { name: "Transcribe 1", exact: true })).toBeDisabled();
  await expect(lyrics.getByRole("tab", { name: "Translate" })).toHaveCount(0);

  expect(serviceRequests).toEqual([]);
});
