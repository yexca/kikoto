import { useEffect, useState, type ReactNode } from "react";

import { assetURL } from "@/lib/api";

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
  const visibleAliases = aliases.filter((alias) => alias && alias !== name).slice(0, 4);
  return (
    <section aria-label={label} className="border-b pb-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <CreatorAvatar name={name} coverUrl={coverUrl} />
          <div className="min-w-0 flex-1">
            {eyebrow && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                {eyebrow}
              </div>
            )}
            <h2 className="mt-1 truncate text-2xl font-semibold leading-tight tracking-tight lg:text-3xl">{name}</h2>
            {visibleAliases.length > 0 && (
              <p className="mt-0.5 truncate text-sm text-muted-foreground" title={visibleAliases.join(", ")}>
                {visibleAliases.join(" / ")}
              </p>
            )}
            {meta}
          </div>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function CreatorAvatar({ name, coverUrl }: { name: string; coverUrl?: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [coverUrl]);
  const initial = Array.from(name.trim())[0] ?? "?";
  return (
    <div
      className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-secondary ring-1 ring-border/60 lg:h-[5.5rem] lg:w-[5.5rem]"
      aria-hidden="true"
    >
      {coverUrl && !imageFailed ? (
        <img
          src={assetURL(coverUrl)}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="grid h-full w-full place-items-center text-2xl font-semibold text-secondary-foreground lg:text-3xl">
          {initial}
        </span>
      )}
    </div>
  );
}
