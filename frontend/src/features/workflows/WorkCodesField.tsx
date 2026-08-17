import { AlertCircle, CheckCircle2, Copy } from "lucide-react";

import { isWorkCode } from "@/lib/workCode";

export type WorkCodesParseResult = {
  codes: string[];
  duplicates: string[];
  invalid: string[];
};

export function parseWorkCodes(value: string): WorkCodesParseResult {
  const tokens = value
    .split(/[\s,;，；]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  const codes: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const code = token.toUpperCase();
    if (!isWorkCode(code)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(code)) {
      duplicates.push(code);
      continue;
    }
    seen.add(code);
    codes.push(code);
  }
  return { codes, duplicates, invalid };
}

export function WorkCodesField({
  value,
  onChange,
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const parsed = parseWorkCodes(value);
  return (
    <div className={`space-y-2 ${className}`}>
      <textarea
        className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={"RJ00000000\nRJ00000001"}
        aria-label={ariaLabel}
        autoCapitalize="off"
        spellCheck={false}
      />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          {parsed.codes.length} valid
        </span>
        <span className="inline-flex items-center gap-1">
          <Copy className="h-3.5 w-3.5" />
          {parsed.duplicates.length} duplicate
        </span>
        <span className={`inline-flex items-center gap-1 ${parsed.invalid.length > 0 ? "text-error-foreground" : ""}`}>
          <AlertCircle className="h-3.5 w-3.5" />
          {parsed.invalid.length} invalid
        </span>
      </div>
      {parsed.invalid.length > 0 && (
        <div className="break-words text-xs text-error-foreground">Invalid: {parsed.invalid.join(", ")}</div>
      )}
      {parsed.codes.length > 0 && (
        <div className="max-h-20 overflow-y-auto rounded border bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          {parsed.codes.join("\n")}
        </div>
      )}
    </div>
  );
}
