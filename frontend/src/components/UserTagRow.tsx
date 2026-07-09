import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type UserTag = {
  id: number;
  name: string;
  color?: string;
};

type UserTagRowProps = {
  tags: UserTag[];
  onSave: (tags: string[]) => Promise<void> | void;
  className?: string;
  compact?: boolean;
};

export function UserTagRow({ tags, onSave, className = "", compact = false }: UserTagRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isEditing) {
      setDraft(tags.map((tag) => tag.name).join(", "));
    }
  }, [isEditing, tags]);

  const save = async () => {
    setIsSaving(true);
    try {
      await onSave(splitTagDraft(draft));
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  if (isEditing) {
    return (
      <div className={`flex min-w-0 flex-1 items-center gap-2 ${className}`}>
        <input
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="tag1, tag2"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") setIsEditing(false);
          }}
        />
        <Button size="sm" variant="outline" disabled={isSaving} onClick={() => void save()}>
          Save
        </Button>
        <Button size="icon" variant="ghost" aria-label="Cancel tag edit" disabled={isSaving} onClick={() => setIsEditing(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  const visibleTags = compact ? tags.slice(0, 4) : tags;
  const hiddenCount = tags.length - visibleTags.length;

  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>
      {visibleTags.map((tag) => (
        <Badge key={tag.id} variant="outline" className="max-w-32 truncate">
          {tag.name}
        </Badge>
      ))}
      {hiddenCount > 0 && <Badge variant="secondary">+{hiddenCount}</Badge>}
      <Button
        type="button"
        variant={tags.length > 0 ? "ghost" : "outline"}
        size="icon"
        className="h-7 w-7"
        aria-label="Add tag"
        title="Add tag"
        onClick={(event) => {
          event.stopPropagation();
          setDraft(tags.map((tag) => tag.name).join(", "));
          setIsEditing(true);
        }}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function splitTagDraft(value: string) {
  const seen = new Set<string>();
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
