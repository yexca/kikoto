import { ArrowDown, ArrowUp, GripVertical, PlayCircle, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import type { DirectoryRoutingRule } from "@/lib/api";
import i18n from "@/i18n";
const maintenanceCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`maintenance.${key}`, options);

export function FolderPreferences({
  rules,
  onRulesChange,
  onSave,
}: {
  rules: DirectoryRoutingRule[];
  onRulesChange: (rules: DirectoryRoutingRule[]) => void;
  onSave: () => Promise<void>;
}) {
  const [draggedRuleId, setDraggedRuleId] = useState<string | null>(null);
  const draggedRuleIdRef = useRef<string | null>(null);
  const applyRules = (next: DirectoryRoutingRule[]) => onRulesChange(reweightDirectoryRoutingRules(next));
  const patchRule = (index: number, patch: Partial<DirectoryRoutingRule>) => {
    onRulesChange(rules.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch, enabled: true } : rule)));
  };
  const moveRuleTo = (index: number, nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= rules.length) return;
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(nextIndex, 0, rule);
    applyRules(next);
  };
  const moveRule = (index: number, direction: -1 | 1) => moveRuleTo(index, index + direction);
  const addRule = () => {
    applyRules([
      ...rules,
      {
        id: `rule_${Date.now()}`,
        label: "New rule",
        weight: 20,
        aliases: ["keyword"],
        negativeAliases: [],
        enabled: true,
      },
    ]);
  };
  const removeRule = (index: number) => applyRules(rules.filter((_, ruleIndex) => ruleIndex !== index));
  const finishDrag = () => {
    draggedRuleIdRef.current = null;
    setDraggedRuleId(null);
  };

  useEffect(() => {
    if (draggedRuleId === null) return;
    const finish = () => {
      draggedRuleIdRef.current = null;
      setDraggedRuleId(null);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, [draggedRuleId]);

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <PlayCircle className="h-4 w-4" />
              </span>
              <span className="truncate">{i18n.t("settings.folderPreference")}</span>
            </span>
            <Button variant="outline" size="sm" onClick={addRule}>
              <Plus className="h-4 w-4" />
              {maintenanceCopy("routing.addRule")}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative space-y-2 before:absolute before:bottom-5 before:left-5 before:top-5 before:w-px before:bg-border">
            {rules.map((rule, index) => (
              <DirectoryRuleEditor
                key={rule.id || index}
                rule={rule}
                index={index}
                canMoveUp={index > 0}
                canMoveDown={index < rules.length - 1}
                onPatch={(patch) => patchRule(index, patch)}
                onMove={moveRule}
                onDragStart={() => {
                  draggedRuleIdRef.current = rule.id;
                  setDraggedRuleId(rule.id);
                }}
                onDragMove={(clientX, clientY) => {
                  const sourceId = draggedRuleIdRef.current;
                  const source = rules.findIndex((candidate) => candidate.id === sourceId);
                  const target = Number(
                    document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-routing-rule-index]")
                      ?.dataset.routingRuleIndex,
                  );
                  if (source >= 0 && Number.isInteger(target) && source !== target) {
                    moveRuleTo(source, target);
                  }
                }}
                onDragEnd={finishDrag}
                dragging={draggedRuleId === rule.id}
                onRemove={() => removeRule(index)}
              />
            ))}
            {rules.length === 0 && (
              <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
                {i18n.t("settings.folderEmpty")}
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void onSave()}>
              <Save className="h-4 w-4" />
              {i18n.t("settings.saveFolderPreferences")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DirectoryRuleEditor({
  rule,
  index,
  canMoveUp,
  canMoveDown,
  onPatch,
  onMove,
  onDragStart,
  onDragMove,
  onDragEnd,
  dragging,
  onRemove,
}: {
  rule: DirectoryRoutingRule;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPatch: (patch: Partial<DirectoryRoutingRule>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDragStart: () => void;
  onDragMove: (clientX: number, clientY: number) => void;
  onDragEnd: () => void;
  dragging: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      data-routing-rule-index={index}
      data-routing-rule-id={rule.id}
      className={`relative flex min-w-0 gap-3 ${dragging ? "opacity-55" : ""}`}
    >
      <div className="relative z-[1] flex w-10 shrink-0 flex-col items-center gap-1.5">
        <button
          type="button"
          className="grid h-8 w-8 touch-none cursor-grab place-items-center rounded-md border bg-card text-muted-foreground active:cursor-grabbing"
          aria-label={`Drag ${rule.label}`}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onDragStart();
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) onDragMove(event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            onDragEnd();
          }}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-3xs font-semibold text-primary-foreground">
          {index + 1}
        </span>
      </div>
      <details className="group min-w-0 flex-1 rounded-md border bg-background">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 marker:hidden">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{rule.label}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {maintenanceCopy("routing.matchKeywords", { count: rule.aliases.length })}
              {rule.negativeAliases.length > 0
                ? ` · ${maintenanceCopy("routing.exclusions", { count: rule.negativeAliases.length })}`
                : ""}
            </div>
          </div>
          <span className="text-xs text-muted-foreground group-open:hidden">{maintenanceCopy("routing.edit")}</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">{maintenanceCopy("close")}</span>
        </summary>
        <div className="space-y-3 border-t p-3">
          <TextInput
            label={maintenanceCopy("routing.ruleName")}
            value={rule.label}
            onChange={(value) => onPatch({ label: value })}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <TagListInput
              label={maintenanceCopy("routing.aliases")}
              value={rule.aliases}
              onChange={(aliases) => onPatch({ aliases })}
            />
            <TagListInput
              label={maintenanceCopy("routing.negativeAliases")}
              value={rule.negativeAliases}
              onChange={(negativeAliases) => onPatch({ negativeAliases })}
            />
          </div>
          <div className="flex flex-wrap justify-between gap-2 border-t pt-3">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={!canMoveUp} onClick={() => onMove(index, -1)}>
                <ArrowUp className="h-4 w-4" />
                {i18n.t("settings.folderEarlier")}
              </Button>
              <Button variant="outline" size="sm" disabled={!canMoveDown} onClick={() => onMove(index, 1)}>
                <ArrowDown className="h-4 w-4" />
                {i18n.t("settings.folderLater")}
              </Button>
            </div>
            <Button variant="outline" size="sm" className="text-destructive" onClick={onRemove}>
              <Trash2 className="h-4 w-4" />
              {i18n.t("settings.folderDelete")}
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

export function reweightDirectoryRoutingRules(rules: DirectoryRoutingRule[]) {
  if (rules.length === 0) return [];
  const step = rules.length === 1 ? 0 : Math.min(10, Math.max(1, Math.floor(80 / (rules.length - 1))));
  const firstWeight = rules.length === 1 ? 40 : 20 + step * (rules.length - 1);
  return rules.map((rule, index) => ({ ...rule, weight: firstWeight - step * index, enabled: true }));
}

function TagListInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Textarea value={value.join(", ")} onChange={(event) => onChange(splitRuleTokens(event.target.value))} />
      <span className="text-xs text-muted-foreground">{maintenanceCopy("routing.keywordHint")}</span>
    </label>
  );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function splitRuleTokens(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}
