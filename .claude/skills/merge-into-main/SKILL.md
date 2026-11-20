---
name: merge-into-main
description: Merge or integrate a finished Kikoto branch into local main when the maintainer asks, including the squash-or-merge-commit decision, the signed commit, and the privacy scan before it.
---

# Merge Into main

The squash-or-merge-commit rule and the commit formats are in
[Merging Into main](../../../docs/development/commit-and-release.md#merging-into-main).
Commits are signed through the 1Password agent; the signing rule and the push
and PR limits are in the
[agent guide](../../../AGENTS.md#release-and-handoff).

1. Merge into the local `main` checkout, which is usually ahead of
   `origin/main` and is not pushed. Do not push unless asked. Before starting,
   run `git status` in the `main` checkout. Another session's half-finished
   merge (`.git/MERGE_HEAD`, staged files) or uncommitted edits there are not
   yours to commit, stash, or discard: stop and tell the maintainer.
2. Decide squash or merge commit for the branch as a whole, using the rule in
   the doc. Read `git log --oneline main..<branch>` to judge it, and state the
   decision and the reason in one line before you merge.
3. Catch the branch up with `main` inside the branch's worktree
   (`git merge --no-ff main`), with the message
   `merge(main): integrate <summary>`. Resolve conflicts there. A numbered
   migration that `main` took in the meantime is renumbered by the branch; the
   steps are in the `schema-migration` skill.
4. Validate with the smallest sufficient targets from
   [Validation Commands](../../../AGENTS.md#validation), chosen from
   the files the branch changes relative to `main`. Do not run two targets that
   both reinstall `node_modules` (`frontend-e2e` and `ci-production`) at once.
5. Stage the final result without committing it, from the `main` checkout:
   `git merge --squash <branch>` or `git merge --no-ff --no-commit <branch>`.
   Check `git diff --cached <branch>` is empty, then run `make sensitive-check`.
   It reads the working-tree diff against `HEAD`, so it sees nothing after the
   commit exists. Review its findings, and review every change to
   `scripts/privacy-allowlist.json` as
   [Before Committing](../../../docs/development/testing.md#before-committing)
   describes. A finding in a file the branch did not change is `main`'s, not
   the branch's.
6. If `main` moved during validation, catch up again and revalidate only in
   proportion to what `main` added since the last validated state.
7. Commit with the message the doc prescribes, a signed commit with no
   `--no-gpg-sign` or signer override. A merge commit takes
   `git commit -F <message file>` on the staged merge. If signing fails
   (`failed to write commit object`, a 1Password error, a stalled prompt), stop
   and ask the maintainer to approve the agent; once they confirm, finish with
   the same `git commit -F`, not a second `git merge`.
8. Report the resulting commit. Delete the branch only after the maintainer
   agrees, and for a squash confirm `git diff main <branch>` is empty first, as
   the doc says.
