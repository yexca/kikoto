import { useEffect, useRef, useState } from "react";
import {
  api,
  type EffectiveMetadataTag,
  type MetadataTag,
  type MetadataTagOverride,
  type WorkMetadataTags,
} from "@/lib/api";
import {
  changeMetadataTagOverride,
  changedMetadataTagNames,
  manualMetadataTagNames,
  metadataTagOverrideKey,
  sameMetadataTagName,
} from "@/lib/metadataTagModel";

/** A custom tag this save creates: its typed name is the all-language name. */
type DraftTag = { id: number; name: string; names: Record<string, string> };

/** A shared tag's full record, loaded when its names are first opened. */
export type TagDetail = { status: "loading" } | { status: "failed" } | { status: "ready"; tag: MetadataTag };

/**
 * Owns one work's tag draft: additions and removals, new custom tags, and edits
 * to the per-language names of the shared tags on this work. Nothing is
 * written until `save`.
 */
export function useWorkMetadataTagsEditor(workId: number) {
  const [initial, setInitial] = useState<WorkMetadataTags | null>(null);
  const [tags, setTags] = useState<EffectiveMetadataTag[]>([]);
  const [overrides, setOverrides] = useState<MetadataTagOverride[]>([]);
  const [failed, setFailed] = useState(false);
  const [drafts, setDrafts] = useState<DraftTag[]>([]);
  const [details, setDetails] = useState<Record<number, TagDetail>>({});
  const [nameDrafts, setNameDrafts] = useState<Record<number, Record<string, string>>>({});
  const nextDraftID = useRef(-1);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .getWorkMetadataTags(workId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setInitial(result);
        setTags(result.tags);
        setOverrides(result.overrides);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [workId, reload]);

  const savedNames = (id: number) => {
    const detail = details[id];
    return detail?.status === "ready" ? manualMetadataTagNames(detail.tag) : {};
  };
  // Name edits count only for shared tags that are still on this work.
  const nameChanges = (id: number) =>
    details[id]?.status === "ready" ? changedMetadataTagNames(nameDrafts[id] ?? {}, savedNames(id)) : {};
  const renamedTags = tags.filter((tag) => tag.id > 0 && Object.keys(nameChanges(tag.id)).length > 0);
  const membershipChanged =
    initial !== null &&
    (drafts.length > 0 || metadataTagOverrideKey(initial.overrides) !== metadataTagOverrideKey(overrides));
  const changed = membershipChanged || renamedTags.length > 0;

  const loadDetail = (id: number) => {
    if (id < 0 || details[id]?.status === "loading" || details[id]?.status === "ready") return;
    setDetails((current) => ({ ...current, [id]: { status: "loading" } }));
    api
      .getMetadataTag(id)
      .then((tag) => setDetails((current) => ({ ...current, [id]: { status: "ready", tag } })))
      .catch(() => setDetails((current) => ({ ...current, [id]: { status: "failed" } })));
  };

  return {
    tags,
    failed,
    ready: initial !== null,
    changed,
    hasOverrides: Boolean(initial?.overrides.length),
    // Restoring matters only while the draft differs from the inherited tags.
    canRestore: drafts.length > 0 || overrides.length > 0,
    isAdded: (id: number) => id < 0 || overrides.some((override) => override.tagId === id && override.action === "add"),
    isRenamed: (id: number) =>
      id < 0
        ? Object.values(drafts.find((tag) => tag.id === id)?.names ?? {}).some((name) => name.trim())
        : Object.keys(nameChanges(id)).length > 0,
    detail: (id: number) => details[id],
    /** Loads a shared tag's names once; calling it again after a failure retries. */
    loadDetail,
    /** The name shown in a language's field: the draft, else the saved manual name. */
    nameValue: (id: number, language: string) =>
      id < 0
        ? (drafts.find((tag) => tag.id === id)?.names[language] ?? "")
        : (nameDrafts[id]?.[language] ?? savedNames(id)[language] ?? ""),
    savedName: (id: number, language: string): string | undefined => savedNames(id)[language],
    draftName: (id: number, language: string): string | undefined => nameDrafts[id]?.[language],
    setName: (id: number, language: string, name: string) => {
      if (id < 0) {
        setDrafts((current) =>
          current.map((tag) => (tag.id === id ? { ...tag, names: { ...tag.names, [language]: name } } : tag)),
        );
      } else {
        setNameDrafts((current) => ({ ...current, [id]: { ...current[id], [language]: name } }));
      }
    },
    retry: () => setReload((value) => value + 1),
    add: (tag: MetadataTag) => {
      setOverrides((current) => changeMetadataTagOverride(current, tag.id, "add"));
      setTags((current) =>
        current.some((entry) => entry.id === tag.id)
          ? current
          : [...current, { id: tag.id, displayName: tag.displayName, source: "manual" }],
      );
    },
    stage: (name: string) => {
      name = name.trim();
      if (!name || tags.some((tag) => sameMetadataTagName(tag.displayName, name))) return;
      const id = nextDraftID.current--;
      setDrafts((current) => [...current, { id, name, names: {} }]);
      setTags((current) => [...current, { id, displayName: name, source: "manual" }]);
    },
    remove: (id: number) => {
      if (id < 0) setDrafts((current) => current.filter((tag) => tag.id !== id));
      else setOverrides((current) => changeMetadataTagOverride(current, id, "remove"));
      setTags((current) => current.filter((tag) => tag.id !== id));
    },
    restore: () => {
      setDrafts([]);
      setOverrides([]);
      setTags(initial?.inheritedTags ?? []);
    },
    save: async () => {
      if (!changed) return;
      // Shared names first, so a later membership failure does not hide a rename that already saved.
      for (const tag of renamedTags) {
        const saved = await api.updateMetadataTag(tag.id, { names: nameChanges(tag.id) });
        setDetails((current) => ({ ...current, [tag.id]: { status: "ready", tag: saved } }));
        setNameDrafts((current) => {
          const next = { ...current };
          delete next[tag.id];
          return next;
        });
      }
      if (!membershipChanged) return;
      const newTagNames = Object.fromEntries(
        drafts
          .map((tag) => [
            tag.name,
            Object.fromEntries(
              Object.entries(tag.names)
                .map(([language, name]) => [language, name.trim()] as const)
                .filter(([language, name]) => language && name),
            ),
          ])
          .filter(([, names]) => Object.keys(names).length > 0),
      );
      const result = await api.setWorkMetadataTags(
        workId,
        overrides,
        drafts.map((tag) => tag.name),
        newTagNames,
      );
      setDrafts([]);
      setInitial(result);
      setTags(result.tags);
      setOverrides(result.overrides);
    },
  };
}

export type WorkMetadataTagsEditor = ReturnType<typeof useWorkMetadataTagsEditor>;
