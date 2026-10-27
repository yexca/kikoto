import type { LLMTranslationModel } from "@/lib/llmApi";

/** The lyrics language of each interface language. */
const interfaceLyricsLanguages: Record<string, string> = {
  ja: "ja-jp",
  en: "en-us",
  "zh-Hans": "zh-cn",
  "zh-Hant": "zh-tw",
  ko: "ko-kr",
};

/** The lyrics language of an interface language, English for any other. */
export function interfaceLyricsLanguage(interfaceLanguage: string | undefined): string {
  return interfaceLyricsLanguages[interfaceLanguage ?? ""] ?? interfaceLyricsLanguages.en;
}

/**
 * The target languages a model translates into from the work's original
 * language, or null when the model translates any direction.
 */
export function modelTranslationTargets(
  service: Pick<LLMTranslationModel, "modelTargets"> | null | undefined,
  model: string | undefined,
): string[] | null {
  if (!service || !model) return null;
  return service.modelTargets?.[model] ?? null;
}

/**
 * Whether a model translates from a source language into a target, or null
 * when the model translates any direction. An unknown source, the empty
 * language, matches every declared source.
 */
export function modelTranslationDirection(
  service: Pick<LLMTranslationModel, "modelPairs"> | null | undefined,
  model: string | undefined,
): ((source: string, target: string) => boolean) | null {
  const pairs = service && model ? service.modelPairs?.[model] : undefined;
  if (!pairs) return null;
  return (source, target) => pairs.some((pair) => (source === "" || pair.source === source) && pair.target === target);
}

/**
 * The target language a translation uses: the chosen language while the model
 * translates into it, otherwise the interface language's lyrics language when
 * the model translates into that, otherwise the first offered language the
 * model translates into. A model that offers none keeps the preferred
 * language, which then shows as unavailable.
 */
export function translationTarget({
  chosen,
  preferred,
  targets,
  offered,
}: {
  chosen: string | null;
  preferred: string;
  targets: string[] | null;
  offered: readonly string[];
}): string {
  const supported = (language: string) => targets === null || targets.includes(language);
  if (chosen && supported(chosen)) return chosen;
  if (supported(preferred)) return preferred;
  return offered.find((language) => targets?.includes(language)) ?? preferred;
}
