import { assetURL } from "@/lib/api";

/**
 * A circle's or voice actor's latest known work cover, beside the name it
 * illustrates. Decorative: the name next to it carries the meaning, so an
 * entry without a cached cover shows its initial instead.
 */
export function MetadataEntryCover({ url, name }: { url?: string; name: string }) {
  const initial = Array.from(name.trim())[0] ?? "?";
  return (
    <div
      className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary ring-1 ring-foreground/5"
      aria-hidden="true"
    >
      {url ? (
        <img src={assetURL(url)} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="text-base font-semibold text-secondary-foreground">{initial}</span>
      )}
    </div>
  );
}
