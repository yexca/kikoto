import type { LLMAssessment } from "@/lib/api";

export type ContentClass = LLMAssessment["class"];

/** The part of a speech recognition service or LLM provider that decides what content it may receive. */
export type ContentBoundary = { boundary: string; allowSensitive: boolean };

/**
 * Whether a service may receive content of a class, as the server decides
 * before every request: safe content goes to any service, sensitive content
 * only to a private service allowed to receive it, and unknown or blocked
 * content to none.
 */
export function serviceReceives(contentClass: ContentClass, service: ContentBoundary) {
  return (
    contentClass === "safe" ||
    (contentClass === "sensitive" && service.boundary === "private" && service.allowSensitive)
  );
}
