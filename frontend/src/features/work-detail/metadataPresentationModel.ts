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
export function metadataVariantLabel(
  variant: WorkMetadataVariant,
  variants: WorkMetadataVariant[],
  labels: MetadataVariantLabels,
): string {
  const language = variant.language.trim().toLowerCase();
  const sameLanguageCount = variants.filter((candidate) => candidate.language.trim().toLowerCase() === language).length;
  let prefix = labels.language(variant.language);
  if (variant.origin) prefix = language ? `${labels.original} · ${prefix}` : labels.original;
  return sameLanguageCount > 1 ? `${prefix} · ${variant.key}` : prefix;
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
