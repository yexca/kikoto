/** Shared ASR/LLM content policy contract, independent of the data boundary. */
export type ContentMaximum = "safe" | "sensitive" | "restricted";
export type ContentClass = ContentMaximum | "unknown" | "blocked";
export type ContentAction = "sensitive" | "restricted" | "blocked";
export type ContentBoundary = { maxContentClass: ContentMaximum };

export const contentMaxima: ContentMaximum[] = ["safe", "sensitive", "restricted"];

export function serviceReceives(contentClass: ContentClass, service: ContentBoundary) {
  const content = contentMaxima.indexOf(contentClass as ContentMaximum);
  const maximum = contentMaxima.indexOf(service.maxContentClass);
  return content >= 0 && maximum >= 0 && content <= maximum;
}
