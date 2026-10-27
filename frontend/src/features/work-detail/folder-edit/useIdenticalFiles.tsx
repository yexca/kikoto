import { useMemo, useState } from "react";

import {
  withFolderEditPaths,
  type FolderEditFile,
  type FolderEditResource,
} from "@/features/work-detail/folder-edit/folderEditModel";
import type { FolderWorkspaceIdentical } from "@/features/work-detail/folder-edit/folderWorkspace";
import {
  FindIdenticalButton,
  IdenticalBadge,
  IdenticalFilesStatus,
  IdenticalReview,
} from "@/features/work-detail/folder-edit/IdenticalFiles";
import {
  identicalFiles,
  identicalSetState,
  withIdenticalPlan,
  type IdenticalSet,
} from "@/features/work-detail/folder-edit/identicalFilesModel";
import { useDuplicateFileCheck } from "@/features/work-detail/folder-edit/useDuplicateFileCheck";

const noPaths: ReadonlySet<string> = new Set();

/**
 * Finds the edited folder's files that have an identical copy and reviews
 * them. Every choice is a change to which files the edit keeps, so To be
 * deleted, Undo all changes, and Restore follow it like any other selection.
 */
export function useIdenticalFiles({
  workId,
  files,
  resources,
  kept,
  setKept,
  disabled,
}: {
  workId: number;
  /** The edited folder's files. */
  files: readonly FolderEditFile[];
  resources: readonly FolderEditResource[];
  /** The edited folder's files the edit keeps. */
  kept: ReadonlySet<string>;
  setKept: (kept: ReadonlySet<string>) => void;
  disabled: boolean;
}): FolderWorkspaceIdentical {
  const duplicateCheck = useDuplicateFileCheck(workId);
  const { check } = duplicateCheck;
  const found = useMemo(
    () => (check.status === "done" ? identicalFiles(check.groups, files, resources) : null),
    [check, files, resources],
  );
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({});
  const [onlyIdentical, setOnlyIdentical] = useState(false);
  const sets = useMemo(
    () => (found?.sets ?? []).map((set) => ({ set, state: identicalSetState(set, kept, choices[set.key]) })),
    [choices, found, kept],
  );
  const count = found?.byPath.size ?? 0;
  const frees = sets.reduce((sum, { set, state }) => sum + set.sizeBytes * state.planned.length, 0);
  const queued = sets.reduce((sum, { state }) => sum + state.deleting.length, 0);
  const paths = useMemo(() => (found ? new Set(found.byPath.keys()) : noPaths), [found]);
  const only = onlyIdentical && count > 0;

  const apply = (set: IdenticalSet, keep: string | null) => setKept(withIdenticalPlan(kept, set, keep));
  const keepSet = (set: IdenticalSet) =>
    setKept(
      withFolderEditPaths(
        kept,
        set.inside.map((copy) => copy.path),
        true,
      ),
    );
  const choose = (set: IdenticalSet, path: string) => {
    setChoices((current) => ({ ...current, [set.key]: path }));
    // A set the edit already thins out keeps the newly chosen copy instead.
    if (identicalSetState(set, kept, choices[set.key]).status !== "none") apply(set, path);
  };
  const applyAll = () => {
    let next: ReadonlySet<string> = kept;
    for (const { set, state } of sets) next = withIdenticalPlan(next, set, state.keep);
    setKept(next);
  };
  const keepAll = () =>
    setKept(
      withFolderEditPaths(
        kept,
        sets.flatMap(({ set }) => set.inside.map((copy) => copy.path)),
        true,
      ),
    );

  return {
    entry: <FindIdenticalButton check={check} disabled={disabled} onStart={() => void duplicateCheck.start()} />,
    status: (
      <IdenticalFilesStatus
        check={check}
        count={count}
        frees={frees}
        queued={queued}
        only={only}
        disabled={disabled}
        onOnly={setOnlyIdentical}
        onStop={duplicateCheck.reset}
        onRetry={() => void duplicateCheck.start()}
      />
    ),
    review:
      sets.length > 0 ? (
        <IdenticalReview
          sets={sets}
          frees={frees}
          disabled={disabled}
          onChoose={choose}
          onApply={apply}
          onKeep={keepSet}
          onApplyAll={applyAll}
          onKeepAll={keepAll}
        />
      ) : null,
    count,
    paths,
    badge: (path, options) => {
      const set = found?.byPath.get(path);
      return set ? <IdenticalBadge set={set} path={path} deleting={options?.deleting} /> : null;
    },
    only,
    revision: check.status === "done" ? check.run : 0,
  };
}
