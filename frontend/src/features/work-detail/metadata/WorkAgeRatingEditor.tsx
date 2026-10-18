import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ageRatingPresentation, ageRatingValues, normalizeAgeRating } from "@/lib/ageRating";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { MetadataEditorField } from "./MetadataEditorFields";
import {
  ageRatingStatus,
  allowedManualAgeRatings,
  selectedAgeRating,
  type AgeRatingDraft,
} from "./ageRatingEditorModel";

/**
 * Edits a work's age rating. It fills in a rating the provider does not give,
 * such as for a custom work or a delisted product, or makes the provider's
 * stricter; content safety for ASR and LLM services uses the result.
 */
export function WorkAgeRatingEditor({
  own,
  provider,
  draft,
  onDraft,
}: {
  own?: string;
  provider: string;
  draft: AgeRatingDraft;
  onDraft: (rating: AgeRatingDraft) => void;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const allowed = allowedManualAgeRatings(provider);
  const selected = selectedAgeRating(draft, own, provider);
  const providerRating = normalizeAgeRating(provider);
  return (
    <MetadataEditorField
      label={t("metadataEditor.ageRating")}
      status={ageRatingStatus(draft, own, provider)}
      revertLabel={t("metadataEditor.revertAgeRating")}
      onRevert={() => onDraft(null)}
      onUndoRevert={() => onDraft(undefined)}
    >
      <p id={hintId} className="text-xs text-muted-foreground">
        {providerRating
          ? t("metadataEditor.ageRatingProviderHint", { rating: ageRatingPresentation(providerRating).label })
          : t("metadataEditor.ageRatingMissingHint")}
      </p>
      <div
        role="radiogroup"
        aria-label={t("metadataEditor.ageRating")}
        aria-describedby={hintId}
        className={segmentedListClassName()}
      >
        {ageRatingValues.map((rating) => (
          <button
            key={rating}
            type="button"
            role="radio"
            aria-checked={selected === rating}
            disabled={!allowed.includes(rating)}
            className={segmentedItemClassName(selected === rating)}
            onClick={() => onDraft(rating)}
          >
            {ageRatingPresentation(rating).label}
          </button>
        ))}
      </div>
    </MetadataEditorField>
  );
}
