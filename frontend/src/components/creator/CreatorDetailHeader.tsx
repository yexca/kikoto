import { useEffect, useState, type ReactNode } from "react";

import { assetURL } from "@/lib/api";

/**
 * Identity summary for a circle or voice actor, shaped like the work detail
 * Hero: the latest cover as a square portrait, the name and personal tags, an
 * optional summary such as catalog statistics, and the quiet action row. The
 * cover tint alone sets it apart from the page; it draws no frame, and the
 * summary keeps to the width of its content.
 */
export function CreatorDetailHeader({
  label,
  name,
  coverUrl,
  eyebrow,
  aliases = [],
  meta,
  actions,
  children,
}: {
  label?: string;
  name: string;
  coverUrl?: string | null;
  eyebrow?: ReactNode;
  aliases?: string[];
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [coverUrl]);
  const cover = coverUrl && !imageFailed ? assetURL(coverUrl) : "";
  const visibleAliases = aliases.filter((alias) => alias && alias !== name).slice(0, 4);
  return (
    <section aria-label={label} className="relative isolate overflow-clip rounded-xl bg-card">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-4 p-4 lg:gap-x-6 lg:p-5">
        <CreatorPortrait name={name} cover={cover} onError={() => setImageFailed(true)} />
        <div className="min-w-0 self-center lg:self-start">
          {eyebrow && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
              {eyebrow}
            </div>
          )}
          <h2 className="mt-1 line-clamp-2 text-2xl font-semibold leading-tight tracking-tight lg:text-3xl">{name}</h2>
          {visibleAliases.length > 0 && (
            <p className="mt-0.5 truncate text-sm text-muted-foreground" title={visibleAliases.join(", ")}>
              {visibleAliases.join(" / ")}
            </p>
          )}
          {meta}
        </div>
        {(children || actions) && (
          <div className="col-span-2 flex min-w-0 flex-col gap-3 lg:col-span-1 lg:col-start-2 lg:-mt-1">
            {children}
            {actions}
          </div>
        )}
      </div>
      {cover && (
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <img src={cover} alt="" className="h-full w-full scale-125 object-cover opacity-25 blur-3xl saturate-150" />
          <div className="absolute inset-0 bg-gradient-to-r from-card/40 via-card/75 to-card" />
        </div>
      )}
    </section>
  );
}

function CreatorPortrait({ name, cover, onError }: { name: string; cover: string; onError: () => void }) {
  const initial = Array.from(name.trim())[0] ?? "?";
  return (
    <div
      className="relative h-20 w-20 shrink-0 self-start overflow-hidden rounded-xl bg-secondary ring-1 ring-border lg:row-span-2 lg:h-32 lg:w-32"
      aria-hidden="true"
    >
      {cover ? (
        <img src={cover} alt="" className="h-full w-full object-cover" onError={onError} />
      ) : (
        <span className="grid h-full w-full place-items-center text-2xl font-semibold text-secondary-foreground lg:text-4xl">
          {initial}
        </span>
      )}
    </div>
  );
}
