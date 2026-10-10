import { ArrowLeft, RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

/** Shown when a work could not be loaded for a reason other than not existing. */
export function WorkLoadFailed({ code, onBack, onRetry }: { code: string; onBack: () => void; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="mx-auto flex min-h-[50vh] max-w-xl flex-col justify-center py-8" role="alert">
      <TriangleAlert className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h2 className="mt-5 text-2xl font-semibold">{t("library.workLoadFailed")}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t("library.workLoadFailedMessage", { code })}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> {t("notFound.back")}
        </Button>
        <Button onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> {t("common.retry")}
        </Button>
      </div>
    </section>
  );
}
