import { apiTransport, type Work } from "@/lib/api";

/** Where a work's text in the target language comes from. */
export type TranslationSource = "origin" | "edition" | "manual" | "llm" | "missing";

export type TranslationCount = { done: number; total: number };

export type TranslationCoverage = {
  /** The declared language of the family's original edition, or empty when unknown. */
  originLanguage: string;
  title: TranslationSource;
  description: TranslationSource;
  tags: TranslationCount;
  files: TranslationCount;
  lyrics: TranslationCount;
  /** The viewer's own translations into the language that are queued. */
  running: number;
  /** The viewer's own translations into the language waiting for review. */
  review: number;
};

export type TranslationCoverageWork = Work & { translation: TranslationCoverage };

export const translationCoverageFilters = [
  "any",
  "title",
  "description",
  "tags",
  "files",
  "lyrics",
  "complete",
  "all",
] as const;

export type TranslationCoverageFilter = (typeof translationCoverageFilters)[number];

export type TranslationCoveragePage = {
  language: string;
  works: TranslationCoverageWork[];
  total: number;
  page: number;
  pageSize: number;
};

export const translationCoverageApi = {
  list: (
    options: { language: string; missing: TranslationCoverageFilter; query: string; page: number; pageSize: number },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({
      language: options.language,
      missing: options.missing,
      page: String(options.page),
      pageSize: String(options.pageSize),
    });
    if (options.query) params.set("q", options.query);
    return apiTransport.getJSON<TranslationCoveragePage>(`/api/metadata/translation-coverage?${params}`, signal);
  },
};
