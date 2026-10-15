import type { ReactNode } from "react";

/** A quiet loading or empty state in place of a lyrics list. */
export function LyricsNote({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center text-sm text-muted-foreground [&>svg]:h-5 [&>svg]:w-5"
    >
      {icon}
      <p className="max-w-md">{children}</p>
    </div>
  );
}
