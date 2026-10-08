import type { WorkMetadataFieldSource, WorkMetadataPresentation, WorkMetadataVariant } from "@/lib/api";

export function orderedMetadataVariants(variants: WorkMetadataVariant[]): WorkMetadataVariant[] {
  return variants
    .map((variant, index) => ({ variant, index }))
    .sort((left, right) => Number(right.variant.origin) - Number(left.variant.origin) || left.index - right.index)
    .map(({ variant }) => variant);
}

export function resolveMetadataVariant(
  presentation: WorkMetadataPresentation | null | undefined,
  selectedKey: string,
): WorkMetadataVariant | null {
  const variants = orderedMetadataVariants(presentation?.variants ?? []);
  if (variants.length === 0) return null;
  const selected = selectedKey.trim();
  if (selected) {
    const match = variants.find((variant) => variant.key === selected);
    if (match) return match;
  }
  const defaultKey = presentation?.defaultVariantKey?.trim();
  return variants.find((variant) => variant.key === defaultKey) ?? variants[0];
}

export type MetadataVariantLabels = {
  original: string;
  language: (value: string) => string;
};

/**
 * Labels a metadata language choice. An original edition whose language the
 * provider never declared stays unknown, but its label shows only "Original"
 * rather than an unknown-language placeholder; other editions keep theirs.
 */
export function metadataVariantLabel(variant: WorkMetadataVariant, labels: MetadataVariantLabels): string {
  const label = labels.language(variant.language);
  if (!variant.origin) return label;
  return variant.language.trim() ? `${labels.original} · ${label}` : labels.original;
}

export type MetadataLanguageChoice = {
  key: string;
  /** The variant this language shows; selecting the choice selects its key. */
  variant: WorkMetadataVariant;
};

/**
 * Collapses metadata variants into one choice per display language. Titles are
 * edited per language, so several provider editions in one language present as
 * that language: the selected or default edition when it is one of them,
 * otherwise the original edition, otherwise the first in server order. Editions
 * without a declared language cannot be merged and stay separate.
 */
export function metadataLanguageChoices(
  presentation: WorkMetadataPresentation | null | undefined,
  selectedKey: string,
): MetadataLanguageChoice[] {
  const variants = orderedMetadataVariants(presentation?.variants ?? []);
  const active = resolveMetadataVariant(presentation, selectedKey);
  const defaultKey = presentation?.defaultVariantKey?.trim() ?? "";
  const groups = new Map<string, WorkMetadataVariant[]>();
  for (const variant of variants) {
    const language = variant.language.trim().toLowerCase();
    const key = language ? `language:${language}` : `edition:${variant.key}`;
    groups.set(key, [...(groups.get(key) ?? []), variant]);
  }
  return Array.from(groups, ([key, members]) => {
    const preferred =
      members.find((variant) => variant.key === active?.key) ??
      members.find((variant) => variant.key === defaultKey) ??
      members.find((variant) => variant.origin) ??
      members[0];
    // The original language keeps its marker even when another edition shows it.
    const origin = members.some((variant) => variant.origin);
    return { key, variant: origin === preferred.origin ? preferred : { ...preferred, origin } };
  });
}

export type MetadataSourceGroup = { source: string; fields: string[] };

/**
 * Groups remote provenance by source in the server's field order, so a notice
 * can say which values each remote source filled.
 */
export function metadataSourceGroups(fields: WorkMetadataFieldSource[] | null | undefined): MetadataSourceGroup[] {
  const groups: MetadataSourceGroup[] = [];
  for (const item of fields ?? []) {
    const group = groups.find((candidate) => candidate.source === item.source);
    if (group) group.fields.push(item.field);
    else groups.push({ source: item.source, fields: [item.field] });
  }
  return groups;
}
