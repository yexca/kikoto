import type { ReactNode } from "react";

/** The centered icon and message of a settings list that is loading or has no entries. */
export function SettingsEmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">{icon}</span>
      <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
