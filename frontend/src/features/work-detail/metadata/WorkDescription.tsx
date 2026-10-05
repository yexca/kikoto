import { useMemo } from "react";
import { useTranslation } from "react-i18next";

// Provider introductions can contain HTML. Read only their text into React;
// never attach provider markup, links or media to the live document.
export function WorkDescription({ description }: { description?: string }) {
  const { t } = useTranslation();
  const text = useMemo(() => {
    if (!description) return "";
    const template = document.createElement("template");
    template.innerHTML = description;
    template.content.querySelectorAll("script,style,iframe,object").forEach((element) => element.remove());
    template.content.querySelectorAll("br").forEach((element) => element.replaceWith("\n"));
    return template.content.textContent?.trim() ?? "";
  }, [description]);
  if (!text) return null;
  return (
    <section aria-label={t("workTitles.description")} className="rounded-lg border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold">{t("workTitles.description")}</h2>
      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{text}</p>
    </section>
  );
}
