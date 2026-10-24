import type { BadgeProps } from "@/components/ui/badge";
import type { TranslationItem, TranslationItemCategory, TranslationItemState } from "@/lib/translationApi";

/** The groups a review shows within one language, in reading order. */
export type TranslationReviewGroup = "title" | "description" | "tags" | "files" | "lyrics";

export const translationReviewGroups: readonly TranslationReviewGroup[] = [
  "title",
  "description",
  "tags",
  "files",
  "lyrics",
];

export function translationReviewGroup(category: TranslationItemCategory): TranslationReviewGroup {
  switch (category) {
    case "tag":
      return "tags";
    case "file_name":
    case "folder_name":
      return "files";
    default:
      return category;
  }
}

export type TranslationLanguageSection = {
  language: string;
  groups: { group: TranslationReviewGroup; items: TranslationItem[] }[];
};

export type TranslationWorkSection = {
  workId: number;
  workCode: string;
  workTitle: string;
  languages: TranslationLanguageSection[];
};

/**
 * Groups items for review: by work, then by language in the order the
 * languages first appear, then by category in reading order. A transcription
 * joins the lyrics of the language it is written in.
 */
export function groupTranslationItems(items: readonly TranslationItem[]): TranslationWorkSection[] {
  const works = new Map<number, TranslationWorkSection>();
  for (const item of items) {
    let work = works.get(item.workId);
    if (!work) {
      work = { workId: item.workId, workCode: item.workCode, workTitle: item.workTitle, languages: [] };
      works.set(item.workId, work);
    }
    let language = work.languages.find((section) => section.language === item.language);
    if (!language) {
      language = { language: item.language, groups: [] };
      work.languages.push(language);
    }
    const group = translationReviewGroup(item.category);
    let entry = language.groups.find((candidate) => candidate.group === group);
    if (!entry) {
      entry = { group, items: [] };
      language.groups.push(entry);
    }
    entry.items.push(item);
  }
  for (const work of works.values()) {
    for (const language of work.languages) {
      language.groups.sort(
        (left, right) => translationReviewGroups.indexOf(left.group) - translationReviewGroups.indexOf(right.group),
      );
    }
  }
  return [...works.values()];
}

export const translationStateBadges: Record<TranslationItemState, BadgeProps["variant"]> = {
  queued: "secondary",
  waiting_transcription: "secondary",
  requesting: "info",
  ready: "warning",
  accepted: "success",
  rejected: "secondary",
  failed: "error",
  uncertain: "error",
  invalid: "secondary",
  policy_blocked: "warning",
  cancelled: "secondary",
};

/** Failure codes with their own explanation; any other shows a generic one. */
const knownTranslationFailures = new Set([
  "upstream_rejected",
  "upstream_result_unknown",
  "cancelled_result_unknown",
  "endpoint_unavailable",
  "source_changed",
  "source_temporarily_unavailable",
  "provider_changed",
  "policy_changed",
  "policy_blocked",
  "permission_changed",
  "transcription_failed",
  "transcription_rejected",
  "transcription_unavailable",
  "invalid_output",
  "invalid_lyrics_output",
  "translation_output_too_large",
  "unsupported_language_pair",
  "service_not_ready",
  "service_start_failed",
  "service_out_of_memory",
  "service_agreement_required",
  "no_speech",
  "audio_decode_failed",
  "audio_too_long",
  "upstream_failed",
  "no_timestamps",
  "ffmpeg_unavailable",
  "source_unavailable",
  "transcript_too_large",
  "cancelled",
  "lyrics_folder_blocked",
  "accept_failed",
]);

/** The translation key that explains why an item stopped. */
export function translationFailureKey(code: string | undefined) {
  return `translationReview.failures.${code && knownTranslationFailures.has(code) ? code : "unknown"}`;
}

/** Refusal codes an accept, discard or resend can return, with their own message. */
const knownReviewRefusals = new Set([
  "already_handled",
  "not_ready",
  "not_found",
  "permission_denied",
  "provider_changed",
  "policy_changed",
  "policy_blocked",
  "source_changed",
  "transcription_rejected",
  "lyrics_folder_blocked",
  "llm_acknowledgement_required",
  "not_resendable",
  "already_active",
  "accept_failed",
]);

export function translationRefusalKey(code: string | undefined) {
  return `translationReview.refusals.${code && knownReviewRefusals.has(code) ? code : "unknown"}`;
}

/** Whether the item's text fits inline; lyrics are read as files. */
export function hasInlineText(item: Pick<TranslationItem, "category">) {
  return item.category !== "lyrics";
}

/**
 * The ids an "accept all" of a group sends: every item waiting for review. A
 * translation read from a transcription brings the transcription with it, so
 * the transcription is not listed twice.
 */
export function acceptableIds(items: readonly TranslationItem[]) {
  return items.filter((item) => item.state === "ready").map((item) => item.id);
}
