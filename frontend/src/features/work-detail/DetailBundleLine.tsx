import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WorkBundleMember, WorkBundleRef } from "@/lib/api";
import { openWorkCodeRoute } from "@/features/work-detail/workDetailShared";

const labelClassName = "shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground";
const linkClassName =
  "min-w-0 truncate rounded-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline";

/**
 * The bundle relation of a work: the works an official bundle includes, and
 * the bundles that include this work. A code outside the library links to its
 * DLsite page.
 */
export function DetailBundleLine({
  bundleMembers,
  includedInBundles,
}: {
  bundleMembers?: WorkBundleMember[] | null;
  includedInBundles?: WorkBundleRef[] | null;
}) {
  const { t } = useTranslation();
  const members = bundleMembers ?? [];
  const bundles = includedInBundles ?? [];
  if (members.length === 0 && bundles.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      {bundles.length > 0 && <BundleRefRow label={t("libraryDetail.includedInBundles")} items={bundles} />}
      {members.length > 0 && <BundleRefRow label={t("libraryDetail.bundleIncludes")} items={members} />}
    </div>
  );
}

function BundleRefRow({ label, items }: { label: string; items: WorkBundleRef[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <span className={labelClassName}>{label}</span>
      <ul className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1" aria-label={label}>
        {items.map((item, index) => (
          <li key={item.code} className="inline-flex min-w-0 items-baseline">
            {item.work ? (
              <button
                type="button"
                className={linkClassName}
                title={item.work.title}
                onClick={() => openWorkCodeRoute(item.work?.code ?? item.code)}
              >
                {item.work.title || item.work.code}
              </button>
            ) : (
              <span className="inline-flex min-w-0 items-baseline gap-1.5">
                <span className="font-mono text-xs">{item.code}</span>
                {item.url && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="self-center rounded text-muted-foreground hover:text-foreground"
                    aria-label={t("libraryDetail.openMetadataLinkSource", { code: item.code })}
                    title={t("libraryDetail.openMetadataLinkSource", { code: item.code })}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </span>
            )}
            {index < items.length - 1 && <span className="ml-1 text-muted-foreground">·</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
