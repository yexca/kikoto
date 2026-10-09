import { expect, test } from "@playwright/test";

import type { RecommendationAffinityBreakdown, RecommendationBreakdown } from "../../src/lib/api";
import { authenticatedStateFixture, runtimeSettingsFixture, worksPageFixture } from "./fixtures/api";
import { mockApplication, seedPlayer, silentWav, work } from "./fixtures/player-library";

const affinityBreakdown: RecommendationAffinityBreakdown = {
  algorithmVersion: "heuristic-v6",
  lane: "unmarked",
  score: 66,
  rawScore: 66,
  signals: {
    listeningStatus: "none",
    favorite: false,
    positiveTagMatches: 1,
    positiveVoiceMatches: 0,
    positiveCircleMatches: 0,
    negativeTagMatches: 0,
    negativeVoiceMatches: 0,
    negativeCircleMatches: 0,
  },
  components: [{ key: "tag", label: "Tags", matchCount: 1, contribution: 16, cap: 30 }],
};

test("optional local badge failure preserves cards and playback while scoring retries", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await seedPlayer(page, undefined, 1);
  let badgeAttempts = 0;
  await page.route("**/api/works?**", async (route) => {
    const badges = new URL(route.request().url()).searchParams.get("recommendBadges") === "true";
    if (badges) badgeAttempts++;
    const unavailable = badges && badgeAttempts === 1;
    await route.fulfill({
      json: worksPageFixture([{ ...work, recommendScore: badges && !unavailable ? 66 : 0 }], {
        recommendationUnavailable: unavailable,
      }),
    });
  });
  await page.route(/\/api\/media\/1\/stream(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: "audio/wav", body: silentWav(60) }),
  );
  await page.goto("/?sort=recent");
  await expect(page.getByText(work.title, { exact: true })).toBeVisible();
  await page.getByText("Test track", { exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const audio = page.locator("audio").first();
  await expect(audio).toHaveJSProperty("paused", false);
  await page.getByRole("button", { name: "Collapse player", exact: true }).click();

  await page.getByRole("button", { name: "Show recommendation badges", exact: true }).click();
  const failure = page.getByRole("status").filter({ hasText: "Recommendation badges are temporarily unavailable." });
  await expect(failure).toBeVisible();
  await expect(page.getByTestId("work-card")).toHaveCount(1);
  await expect(page.getByText(work.title, { exact: true })).toBeVisible();
  await expect(audio).toHaveJSProperty("paused", false);
  await failure.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Explain recommendation score 66", exact: true })).toBeVisible();
  await expect(failure).toHaveCount(0);
  await expect(audio).toHaveJSProperty("paused", false);
  expect(badgeAttempts).toBe(2);
});

test("recommendation preparation failure retains loaded cards and retries without stopping playback", async ({
  page,
}) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await seedPlayer(page, undefined, 1);
  let recovered = false;
  await page.route("**/api/works?**", async (route) => {
    const recommending = new URL(route.request().url()).searchParams.get("sort") === "recommend";
    if (recommending && !recovered) {
      await route.fulfill({
        status: 503,
        json: {
          code: "service_unavailable",
          error: "Recommendation preparation is temporarily unavailable.",
          retryable: true,
        },
      });
      return;
    }
    await route.fulfill({
      json: worksPageFixture([{ ...work, recommendScore: recommending ? 66 : 0 }], {
        recommendationContext: recommending ? "a".repeat(64) : "",
      }),
    });
  });
  await page.route(/\/api\/media\/1\/stream(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: "audio/wav", body: silentWav(60) }),
  );
  await page.goto("/?sort=recent");
  await expect(page.getByTestId("work-card")).toHaveCount(1);
  await page.getByText("Test track", { exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const audio = page.locator("audio").first();
  await expect(audio).toHaveJSProperty("paused", false);
  await page.getByRole("button", { name: "Collapse player", exact: true }).click();
  await page.getByRole("button", { name: "Sort: Recently added", exact: true }).click();
  await page.getByRole("button", { name: "Recommended", exact: true }).click();
  await expect(page.getByText("Recommendation preparation is temporarily unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("work-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Explain recommendation score/ })).toHaveCount(0);
  await expect(audio).toHaveJSProperty("paused", false);
  recovered = true;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Recommendation preparation is temporarily unavailable.", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId("work-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Explain recommendation score 66", exact: true })).toBeVisible();
  await expect(audio).toHaveJSProperty("paused", false);
});

test("explanations use the server query context and telemetry records the algorithm version", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  const context = "b".repeat(64);
  const explanationRequests: URL[] = [];
  const events: Array<{ contextId: string; algorithmVersion: string }> = [];
  await page.route("**/api/works?**", (route) =>
    route.fulfill({ json: worksPageFixture([{ ...work, recommendScore: 66 }], { recommendationContext: context }) }),
  );
  await page.route("**/api/recommendation-events", async (route) => {
    events.push(...route.request().postDataJSON().events);
    await route.fulfill({ json: { recorded: events.length } });
  });
  await page.route("**/api/works/1/recommendation?**", async (route) => {
    explanationRequests.push(new URL(route.request().url()));
    await route.fulfill({ json: affinityBreakdown });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Explain recommendation score 66", exact: true }).click();
  await expect(page.getByText("heuristic-v6", { exact: true })).toBeVisible();
  expect(explanationRequests).toHaveLength(1);
  expect(explanationRequests[0].searchParams.get("recommendationContext")).toBe(context);
  expect(explanationRequests[0].searchParams.get("recommendationSession")).toBeTruthy();
  await expect.poll(() => events.length).toBeGreaterThan(0);
  expect(events[0]).toMatchObject({ contextId: context, algorithmVersion: "heuristic-v6" });
});

test("an expired context recovers the original session's affinity without ranking adjustments", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  const context = "c".repeat(64);
  const explanationRequests: URL[] = [];
  await page.route("**/api/works?**", (route) =>
    route.fulfill({ json: worksPageFixture([{ ...work, recommendScore: 66 }], { recommendationContext: context }) }),
  );
  await page.route("**/api/works/1/recommendation?**", async (route) => {
    const url = new URL(route.request().url());
    explanationRequests.push(url);
    if (url.searchParams.has("recommendationContext")) {
      await route.fulfill({
        status: 410,
        json: { code: "recommendation_context_expired", error: "Recommendation context expired", retryable: false },
      });
    } else {
      await route.fulfill({ json: affinityBreakdown });
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Explain recommendation score 66", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Affinity score", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Tags", { exact: true })).toBeVisible();
  await expect(dialog.getByText("+16", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Current shuffle adjustment", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Ranking score", { exact: true })).toHaveCount(0);
  expect(explanationRequests).toHaveLength(2);
  expect(explanationRequests[0].searchParams.get("recommendationContext")).toBe(context);
  expect(explanationRequests[1].searchParams.has("recommendationContext")).toBe(false);
  expect(explanationRequests[1].searchParams.get("recommendationSession")).toBe(
    explanationRequests[0].searchParams.get("recommendationSession"),
  );
  expect(explanationRequests[1].searchParams.get("seed")).toBe(explanationRequests[0].searchParams.get("seed"));
});

test("demo explanations label the simulated score and reshuffling keeps the score session", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: runtimeSettingsFixture({ mode: "demo", demoMode: true }) }),
  );
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: authenticatedStateFixture({ demoMode: true }) }));
  const listRequests: URL[] = [];
  await page.route("**/api/works?**", (route) => {
    listRequests.push(new URL(route.request().url()));
    return route.fulfill({ json: worksPageFixture([{ ...work, recommendScore: 72 }]) });
  });
  const breakdown: RecommendationBreakdown = {
    scoreKind: "demo_random",
    algorithmVersion: "demo-random-v1",
    score: 72,
    rawScore: 72,
    components: [],
  };
  await page.route("**/api/works/1/recommendation?**", (route) => route.fulfill({ json: breakdown }));
  await page.goto("/");
  await page.getByRole("button", { name: "Explain recommendation score 72", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Demo score, randomly generated", { exact: true })).toBeVisible();
  await expect(dialog.getByText("72", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Affinity score", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Unmarked discovery", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Tags", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Ranking score", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/Listening state controls the mix/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const first = listRequests.at(-1)!;
  await page.getByRole("button", { name: "Refresh recommendations", exact: true }).click();
  await expect.poll(() => listRequests.at(-1)?.searchParams.get("seed")).not.toBe(first.searchParams.get("seed"));
  expect(listRequests.at(-1)?.searchParams.get("recommendationSession")).toBe(
    first.searchParams.get("recommendationSession"),
  );
  await expect(page.getByRole("button", { name: "Explain recommendation score 72", exact: true })).toBeVisible();
});
