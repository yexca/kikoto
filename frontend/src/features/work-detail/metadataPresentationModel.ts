import type { WorkMetadataPresentation, WorkMetadataVariant } from "@/lib/api";

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
