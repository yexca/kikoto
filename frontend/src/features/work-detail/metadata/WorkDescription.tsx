import { AlignLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

// Introductions are stored as plain text. React escapes markup-like characters
// without parsing away authored angle brackets, ampersands or line breaks.
// The card shares the side column's heading style with Source info and Credits.
export function WorkDescription({ description }: { description?: string }) {
  const { t } = useTranslation();
  if (!description?.trim()) return null;
  return (
    <section aria-label={t("workTitles.description")} className="min-w-0 rounded-xl border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <AlignLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("workTitles.description")}
      </h2>
      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{description}</p>
    </section>
  );
}
