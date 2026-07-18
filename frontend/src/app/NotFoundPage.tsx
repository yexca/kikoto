import { ArrowLeft, Library, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";

export function NotFoundPage({
  title = "Page not found",
  message = "The requested page does not exist or is no longer available.",
  onBack,
  onOpenLibrary,
}: {
  title?: string;
  message?: string;
  onBack: () => void;
  onOpenLibrary: () => void;
}) {
  return (
    <section className="mx-auto flex min-h-[50vh] max-w-xl flex-col justify-center py-8">
      <SearchX className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <p className="mt-5 text-sm font-medium text-muted-foreground">404</p>
      <h2 className="mt-1 text-2xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={onOpenLibrary}>
          <Library className="h-4 w-4" /> Library
        </Button>
      </div>
    </section>
  );
}
