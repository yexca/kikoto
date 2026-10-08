import { ArrowDown, ArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { moveRemoteMetadataSource, toggleRemoteMetadataSource } from "@/features/workflows/remoteMetadataFallbackModel";
import { SwitchControl } from "@/features/workflows/RunOptionControls";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import type { LibrarySource, RemoteMetadataFallbackSettings } from "@/lib/api";

export function MetadataSyncFallbackFields({
  sources,
  value,
  disabled,
  onChange,
}: {
  sources: LibrarySource[];
  value: RemoteMetadataFallbackSettings;
  disabled: boolean;
  onChange: (value: RemoteMetadataFallbackSettings) => void;
}) {
  const rows = [...sources].sort((left, right) => {
    const a = value.sourceIds.indexOf(left.id),
      b = value.sourceIds.indexOf(right.id);
    return (a < 0 ? sources.length : a) - (b < 0 ? sources.length : b);
  });
  const copy = (key: string, name?: string) => workflowCopy(`remoteMetadataFallback.${key}`, { name });
  return (
    <>
      <SwitchControl
        label={copy("enabled")}
        checked={value.enabled}
        disabled={disabled}
        onCheckedChange={(enabled) => onChange({ ...value, enabled })}
      />
      {value.enabled && (
        <ol aria-label={copy("order")} className="divide-y overflow-hidden rounded-lg border bg-card">
          {rows.map((source) => {
            const position = value.sourceIds.indexOf(source.id);
            return (
              <li key={source.id} className="flex min-h-10 items-center gap-2 px-2.5 py-1 text-sm">
                <Checkbox
                  checked={position >= 0}
                  disabled={disabled}
                  aria-label={copy("use", source.displayName)}
                  onCheckedChange={(selected) => onChange(toggleRemoteMetadataSource(value, source.id, selected))}
                />
                <span className="min-w-0 flex-1 truncate">{source.displayName}</span>
                {position >= 0 && (
                  <span className="flex shrink-0 items-center">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={copy("earlier", source.displayName)}
                      disabled={disabled || position === 0}
                      onClick={() => onChange(moveRemoteMetadataSource(value, source.id, -1))}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={copy("later", source.displayName)}
                      disabled={disabled || position === value.sourceIds.length - 1}
                      onClick={() => onChange(moveRemoteMetadataSource(value, source.id, 1))}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
