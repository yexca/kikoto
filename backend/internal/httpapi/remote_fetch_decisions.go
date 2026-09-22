package httpapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (s *Server) remoteFetchSourceOptions(ctx context.Context, primary remoteSourceForUse, workCode string, primaryFiles []remoteSaveFile) map[string][]remoteFetchSourceOption {
	result := map[string][]remoteFetchSourceOption{}
	primaryPathByHash := primaryRemoteFetchPathsByHash(primaryFiles)
	appendRemoteFetchSourceOptions(result, primary, primaryFiles, primaryPathByHash, false)
	s.appendRemoteFetchAlternativeSources(ctx, result, primary, workCode, primaryPathByHash)
	sortRemoteFetchSourceOptions(result, primary.ID)
	return result
}

func primaryRemoteFetchPathsByHash(files []remoteSaveFile) map[string]string {
	paths := map[string]string{}
	for _, file := range files {
		if hash := strings.TrimSpace(file.Hash); hash != "" {
			if _, duplicate := paths[hash]; duplicate {
				paths[hash] = ""
			} else {
				paths[hash] = file.Path
			}
		}
	}
	return paths
}

func appendRemoteFetchSourceOptions(result map[string][]remoteFetchSourceOption, source remoteSourceForUse, files []remoteSaveFile, primaryPathByHash map[string]string, matchPrimary bool) {
	for _, file := range files {
		groupPath := file.Path
		if matchPrimary && strings.TrimSpace(file.Hash) != "" {
			if matched := primaryPathByHash[strings.TrimSpace(file.Hash)]; matched != "" {
				groupPath = matched
			}
		}
		duplicate := false
		for _, option := range result[groupPath] {
			if option.SourceID == source.ID {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		result[groupPath] = append(result[groupPath], remoteFetchSourceOption{
			SourceID: source.ID, SourceCode: source.Code, SourceName: source.DisplayName,
			Path: file.Path, SizeBytes: file.SizeBytes, SourcePath: firstNonEmpty(file.DownloadURL, file.StreamURL), Kind: file.Kind, Hash: file.Hash,
		})
	}
}

func (s *Server) appendRemoteFetchAlternativeSources(ctx context.Context, result map[string][]remoteFetchSourceOption, primary remoteSourceForUse, workCode string, primaryPathByHash map[string]string) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT source.id
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE UPPER(work.primary_code) = UPPER(?)
			AND presence.presence_type IN ('source', 'tracked')
			AND presence.availability = 'available'
			AND source.enabled = 1
			AND source.id <> ?
		ORDER BY source.priority ASC, source.id ASC
	`, workCode, primary.ID)
	if err == nil {
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var sourceID int64
			if rows.Scan(&sourceID) != nil {
				continue
			}
			source, remoteWork, tracks, loadErr := s.loadRemoteWorkTracks(ctx, sourceID, workCode)
			if loadErr != nil || !strings.EqualFold(normalizedRemoteWorkCode(remoteWork), workCode) {
				continue
			}
			appendRemoteFetchSourceOptions(result, source, flattenRemoteSaveFiles(tracks), primaryPathByHash, true)
		}
	}
}

func sortRemoteFetchSourceOptions(result map[string][]remoteFetchSourceOption, primaryID int64) {
	for path := range result {
		sort.SliceStable(result[path], func(i, j int) bool {
			if result[path][i].SourceID == primaryID && result[path][j].SourceID != primaryID {
				return true
			}
			if result[path][j].SourceID == primaryID && result[path][i].SourceID != primaryID {
				return false
			}
			return result[path][i].SourceName < result[path][j].SourceName
		})
	}
}

func normalizeRemoteFetchDecisions(decisions []remoteFetchFileDecision) map[string]remoteFetchFileDecision {
	result := map[string]remoteFetchFileDecision{}
	for _, decision := range decisions {
		decision.ItemKey = strings.TrimSpace(decision.ItemKey)
		switch strings.ToLower(strings.TrimSpace(decision.Resolution)) {
		case "", "auto", "keep_local", "replace", "keep_both", "rename", "exclude":
			decision.Resolution = strings.ToLower(strings.TrimSpace(decision.Resolution))
			if decision.Resolution == "" {
				decision.Resolution = "auto"
			}
		default:
			decision.Resolution = "auto"
		}
		if decision.ItemKey != "" {
			result[decision.ItemKey] = decision
		}
	}
	return result
}

func applyRemoteFetchSourceDecision(item *remoteWorkSavePlanItem, decision remoteFetchFileDecision, options []remoteFetchSourceOption, fallback remoteSourceForUse, workCode string) error {
	selectedID := decision.SourceID
	if selectedID <= 0 {
		selectedID = fallback.ID
	}
	var selected *remoteFetchSourceOption
	for index := range options {
		if options[index].SourceID == selectedID {
			selected = &options[index]
			break
		}
	}
	if selected == nil {
		return fmt.Errorf("selected remote source %d does not provide %s", selectedID, item.Path)
	}
	item.RemoteSourceID = selected.SourceID
	item.RemoteSourceCode = selected.SourceCode
	item.RemoteSourceName = selected.SourceName
	item.RemotePath = selected.Path
	item.SourcePath = selected.SourcePath
	item.CachePath = cacheMediaRelPath(selected.SourceCode, workCode, selected.Path)
	item.SizeBytes = selected.SizeBytes
	if selected.Kind != "" {
		item.Kind = selected.Kind
	}
	return nil
}

func normalizeFetchDecisionTarget(saveRoot string, requested string) (string, error) {
	requested = filepath.ToSlash(strings.TrimSpace(requested))
	if requested == "" {
		return "", fmt.Errorf("renamed target path is required")
	}
	if filepath.IsAbs(requested) || filepath.VolumeName(requested) != "" {
		return "", fmt.Errorf("renamed target must stay inside the Fetch root")
	}
	cleaned := filepath.ToSlash(filepath.Clean(filepath.FromSlash(requested)))
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("renamed target must stay inside the Fetch root")
	}
	root := strings.Trim(filepath.ToSlash(saveRoot), "/")
	if cleaned != root && !strings.HasPrefix(cleaned, root+"/") {
		cleaned = joinRemotePath(root, cleaned)
	}
	if _, err := fetchPathRelativeToRoot(root, cleaned); err != nil {
		return "", err
	}
	return cleaned, nil
}

func (s *Server) applyRemoteFetchConflictDecision(item *remoteWorkSavePlanItem, decision remoteFetchFileDecision, saveRoot string, seenTargets map[string]string) error {
	resolution := strings.ToLower(strings.TrimSpace(decision.Resolution))
	if resolution == "" {
		resolution = "auto"
	}
	item.Resolution = resolution
	switch resolution {
	case "exclude":
		item.Action = "exclude"
		item.Status = "excluded"
		item.TargetConflict = false
		item.TargetConflictReason = ""
	case "keep_local":
		item.Action = "exclude"
		item.Status = "kept_local"
		item.TargetConflict = false
		item.TargetConflictReason = ""
	case "replace":
		item.Action = ""
		item.Status = "replace_target"
		item.TargetConflict = false
		item.TargetConflictReason = ""
	case "keep_both":
		if !item.TargetConflict {
			return nil
		}
		next, err := s.nextAvailableFetchTarget(item.TargetPath, item.RemoteSourceCode, seenTargets)
		if err != nil {
			return err
		}
		item.TargetPath = next
		item.Action = ""
		item.Status = "keep_both"
		item.TargetConflict = false
		item.TargetConflictReason = ""
		seenTargets[next] = item.Path
	case "rename":
		if _, err := fetchPathRelativeToRoot(saveRoot, item.TargetPath); err != nil {
			return err
		}
	case "auto":
		return nil
	}
	return nil
}

func (s *Server) nextAvailableFetchTarget(targetPath string, sourceCode string, seenTargets map[string]string) (string, error) {
	ext := filepath.Ext(targetPath)
	base := strings.TrimSuffix(targetPath, ext)
	label := strings.Trim(sourceCodePattern.ReplaceAllString(strings.ToLower(sourceCode), "_"), "_")
	if label == "" {
		label = "incoming"
	}
	for index := 1; index <= 9999; index++ {
		suffix := " (" + label + ")"
		if index > 1 {
			suffix = fmt.Sprintf(" (%s %d)", label, index)
		}
		candidate := base + suffix + ext
		if _, exists := seenTargets[candidate]; exists {
			continue
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, candidate)
		if err != nil {
			return "", err
		}
		if _, err := os.Stat(absolute); err == nil || !errors.Is(err, os.ErrNotExist) {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("could not allocate a keep-both target for %s", targetPath)
}

func remoteFetchPlanSourceIDs(plan remoteWorkSavePlan, fallback int64) []int64 {
	seen := map[int64]bool{}
	if fallback > 0 {
		seen[fallback] = true
	}
	for _, item := range plan.Items {
		if item.RemoteSourceID > 0 && item.Action != "exclude" {
			seen[item.RemoteSourceID] = true
		}
	}
	result := make([]int64, 0, len(seen))
	for sourceID := range seen {
		result = append(result, sourceID)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func validateResolvedFetchTargets(items []remoteWorkSavePlanItem) {
	seen := map[string]int{}
	for index := range items {
		item := &items[index]
		if item.Action == "exclude" {
			continue
		}
		if previous, exists := seen[item.TargetPath]; exists {
			item.TargetConflict = true
			item.TargetConflictReason = "multiple resolved files still use the same target path: " + items[previous].ItemKey
			item.Action = "conflict"
			item.Status = "duplicate_target"
			continue
		}
		seen[item.TargetPath] = index
	}
}
