package httpapi

import (
	"os"
	"path/filepath"
	"strings"
)

// A planned file whose target an existing entry blocks names the block, so
// the conflict offers only the resolutions that can succeed: a folder or
// other entry that is not a regular file is never replaced, and nothing can be
// created below a file that sits where one of the target's folders belongs.
const (
	targetBlockNotFile     = "not_a_file"
	targetBlockBlockedPath = "blocked_path"
)

// blockingPathEntry returns the path, relative to root, of the first entry
// above the target relative names that exists but is not a plain folder.
func blockingPathEntry(root string, relative string) (string, bool) {
	parts := strings.Split(relative, "/")
	current := root
	for index, part := range parts[:len(parts)-1] {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return "", false
		}
		if !info.IsDir() || unsafeFetchStagingEntry(info) {
			return strings.Join(parts[:index+1], "/"), true
		}
	}
	return "", false
}

// markBlockedPath marks an item as a conflict when a file sits where one of
// its target's folders belongs, and reports whether it did. Platforms differ
// in how they report a target below a file, so this is checked first.
func markBlockedPath(item *remoteWorkSavePlanItem, rootAbsolute, relative string) bool {
	blocker, blocked := blockingPathEntry(rootAbsolute, relative)
	if !blocked {
		return false
	}
	item.TargetConflict = true
	item.Action, item.Status = "conflict", "target_conflict"
	item.TargetBlock = targetBlockBlockedPath
	item.TargetBlocker = blocker
	item.TargetConflictReason = "a file named " + blocker + " is where a folder of this path belongs"
	return true
}

// markNotFileTarget marks an item as a conflict with the folder, link, or
// special file already at its target.
func markNotFileTarget(item *remoteWorkSavePlanItem, info os.FileInfo) {
	item.TargetConflict = true
	item.Action, item.Status = "conflict", "target_conflict"
	item.TargetBlock = targetBlockNotFile
	if info.IsDir() && !unsafeFetchStagingEntry(info) {
		item.TargetConflictReason = "a folder is already at this path"
	} else {
		item.TargetConflictReason = "a link or special file is already at this path"
	}
}

// blockedTargetDecision drops a resolution the item's block makes impossible,
// leaving the conflict unresolved instead of failing when the edit is applied.
func blockedTargetDecision(item remoteWorkSavePlanItem, decision remoteFetchFileDecision) remoteFetchFileDecision {
	resolution := strings.ToLower(strings.TrimSpace(decision.Resolution))
	switch {
	case item.TargetBlock == targetBlockNotFile && resolution == "replace",
		item.TargetBlock == targetBlockBlockedPath && (resolution == "replace" || resolution == "keep_both"):
		decision.Resolution = "auto"
	}
	return decision
}
