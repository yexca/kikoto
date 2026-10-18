import { Check, Loader2, ShieldAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * A notice an administrator reads and accepts before a feature unlocks. It
 * sits over the surface it unlocks; the server keeps refusing the feature
 * until the acceptance is recorded, so the notice never depends on the client.
 */
export function AcceptanceNotice({
  title,
  items,
  scope,
  agreeLabel,
  acceptLabel,
  onAccept,
}: {
  title: string;
  items: ReactNode[];
  scope: string;
  agreeLabel: string;
  acceptLabel: string;
  /** Records the acceptance; a rejection keeps the notice open. */
  onAccept: () => Promise<void>;
}) {
  const titleId = useId();
  const [agreed, setAgreed] = useState(false);
  const [accepting, setAccepting] = useState(false);

  const accept = async () => {
    setAccepting(true);
    try {
      await onAccept();
    } finally {
      setAccepting(false);
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className="theme-floating-surface sticky top-6 mx-auto w-full max-w-lg rounded-[var(--radius)] border bg-popover p-5 text-popover-foreground shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning-surface text-warning-foreground">
          <ShieldAlert className="h-5 w-5" />
        </span>
        <div className="min-w-0 space-y-3">
          <h3 id={titleId} className="text-base font-semibold leading-6">
            {title}
          </h3>
          <ul className="list-disc space-y-2 pl-4 text-sm leading-6 text-muted-foreground">
            {items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <p className="text-xs leading-5 text-muted-foreground">{scope}</p>
          <label className="flex w-fit items-center gap-2 text-sm font-medium">
            <Checkbox checked={agreed} disabled={accepting} aria-label={agreeLabel} onCheckedChange={setAgreed} />
            {agreeLabel}
          </label>
          <div className="flex justify-end">
            <Button size="sm" disabled={!agreed || accepting} onClick={() => void accept()}>
              {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {acceptLabel}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
