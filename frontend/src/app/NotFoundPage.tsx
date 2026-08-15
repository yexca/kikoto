import { ArrowLeft, Library, SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

export function NotFoundPage({
  title,
  message,
  onBack,
  onOpenLibrary,
}: {
  title?: string;
  message?: string;
  onBack: () => void;
  onOpenLibrary: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="mx-auto flex min-h-[50vh] max-w-xl flex-col justify-center py-8">
      <SearchX className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <p className="mt-5 text-sm font-medium text-muted-foreground">404</p>
      <h2 className="mt-1 text-2xl font-semibold">{title ?? t("notFound.title")}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{message ?? t("notFound.message")}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> {t("notFound.back")}
        </Button>
        <Button onClick={onOpenLibrary}>
          <Library className="h-4 w-4" /> {t("notFound.library")}
        </Button>
      </div>
    </section>
  );
}
