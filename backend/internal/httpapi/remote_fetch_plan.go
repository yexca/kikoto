package httpapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type remoteFetchPlanInputs struct {
	workCode      string
	saveRoot      string
	selected      map[string]bool
	selectedLocal map[string]bool
	files         []remoteSaveFile
	localFiles    []remoteWorkSaveLocalFile
	sourceOptions map[string][]remoteFetchSourceOption
	decisions     map[string]remoteFetchFileDecision
	locationState remoteTrackLocationStates
}

func (s *Server) prepareRemoteFetchPlanInputs(
	ctx context.Context,
	source remoteSourceForUse,
	remoteWork kikoeru.Work,
	tracks []kikoeru.Track,
	code string,
	selectedPaths []string,
	selectedLocalPaths []string,
	requestedTargetRoot string,
	decisions []remoteFetchFileDecision,
) (remoteFetchPlanInputs, error) {
	workCode := normalizedRemoteWorkCode(remoteWork)
	if workCode == "" {
		workCode = strings.ToUpper(strings.TrimSpace(code))
	}
	saveRoot, err := s.resolveRemoteFetchSaveRoot(ctx, source, workCode, requestedTargetRoot)
	if err != nil {
		return remoteFetchPlanInputs{}, err
	}
	locationState, err := s.remoteTrackLocationState(ctx, source.ID, workCode)
	if err != nil {
		return remoteFetchPlanInputs{}, err
	}
	return remoteFetchPlanInputs{
		workCode: workCode, saveRoot: saveRoot,
		selected:      normalizeSelectedRemotePaths(selectedPaths),
		selectedLocal: normalizeSelectedLocalPaths(selectedLocalPaths),
		files:         flattenRemoteSaveFiles(tracks),
		localFiles:    remoteWorkSaveLocalFiles(locationState),
		sourceOptions: s.remoteFetchSourceOptions(ctx, source, workCode, flattenRemoteSaveFiles(tracks)),
		decisions:     normalizeRemoteFetchDecisions(decisions), locationState: locationState,
	}, nil
}

func (s *Server) resolveRemoteFetchSaveRoot(ctx context.Context, source remoteSourceForUse, workCode string, requested string) (string, error) {
	saveRoot := s.remoteSaveRoot(source, workCode)
	if strings.TrimSpace(requested) == "" {
		return saveRoot, nil
	}
	requested = filepath.ToSlash(filepath.Clean(filepath.FromSlash(requested)))
	if requested == filepath.ToSlash(filepath.Clean(filepath.FromSlash(saveRoot))) {
		return saveRoot, nil
	}
	return s.validateRemoteFetchTargetRoot(ctx, workCode, requested)
}

func (s *Server) buildRemoteFetchPlanItems(ctx context.Context, source remoteSourceForUse, inputs remoteFetchPlanInputs, seenTargets map[string]string) ([]remoteWorkSavePlanItem, error) {
	items := make([]remoteWorkSavePlanItem, 0, len(inputs.files))
	for _, file := range inputs.files {
		if !selectedRemoteFile(inputs.selected, inputs.selectedLocal, file.Path) {
			continue
		}
		item, err := s.buildRemoteFetchPlanRemoteItem(ctx, source, inputs, file, seenTargets)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func selectedRemoteFile(selected, selectedLocal map[string]bool, path string) bool {
	if len(selected) == 0 && len(selectedLocal) > 0 {
		return false
	}
	return len(selected) == 0 || selectedRemotePathMatches(selected, path)
}

func (s *Server) buildRemoteFetchPlanRemoteItem(
	ctx context.Context,
	source remoteSourceForUse,
	inputs remoteFetchPlanInputs,
	file remoteSaveFile,
	seenTargets map[string]string,
) (remoteWorkSavePlanItem, error) {
	item := remoteWorkSavePlanItem{
		ItemKey: "remote:" + file.Path, Path: file.Path, Kind: file.Kind, SizeBytes: file.SizeBytes,
		SourceKind: "remote", SourcePath: firstNonEmpty(file.DownloadURL, file.StreamURL),
		CachePath:  cacheMediaRelPath(source.Code, inputs.workCode, file.Path),
		TargetPath: filepath.ToSlash(joinRemotePath(inputs.saveRoot, file.Path)), LocalPaths: []string{},
		RemoteSourceID: source.ID, RemoteSourceCode: source.Code, RemoteSourceName: source.DisplayName,
		SourceOptions: inputs.sourceOptions[file.Path],
	}
	item.OriginalTargetPath = item.TargetPath
	decision := inputs.decisions[item.ItemKey]
	if err := applyRemoteFetchSourceDecision(&item, decision, inputs.sourceOptions[file.Path], source, inputs.workCode); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if err := applyRemoteFetchRename(&item, decision, inputs.saveRoot); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if _, err := safeDataPath(s.cfg.DataRoot, item.TargetPath); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if state, ok := inputs.locationState.localForRemotePath(file.Path); ok {
		item.LocalPaths = append(item.LocalPaths, state.Path)
	}
	if err := applyRemoteFetchRemoteTargetState(s.cfg.DataRoot, &item, seenTargets); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if err := s.applyRemoteFetchConflictDecision(&item, decision, inputs.saveRoot, seenTargets); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if _, err := safeDataPath(s.cfg.DataRoot, item.TargetPath); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if item.Action == "" {
		if err := s.defaultRemoteFetchAction(ctx, &item, inputs.workCode); err != nil {
			return remoteWorkSavePlanItem{}, err
		}
	}
	return item, nil
}

func applyRemoteFetchRename(item *remoteWorkSavePlanItem, decision remoteFetchFileDecision, saveRoot string) error {
	if strings.ToLower(strings.TrimSpace(decision.Resolution)) != "rename" {
		return nil
	}
	target, err := normalizeFetchDecisionTarget(saveRoot, decision.TargetPath)
	if err != nil {
		return fmt.Errorf("%s: %w", item.ItemKey, err)
	}
	item.TargetPath = target
	item.Resolution = "rename"
	return nil
}

func applyRemoteFetchTargetState(item *remoteWorkSavePlanItem, seenTargets map[string]string, duplicateMessage string) {
	if previous, exists := seenTargets[item.TargetPath]; exists && !item.TargetConflict {
		item.TargetConflict = true
		item.TargetConflictReason = duplicateMessage + previous
		item.Action = "conflict"
		item.Status = "duplicate_target"
		return
	}
	seenTargets[item.TargetPath] = item.Path
}

func applyRemoteFetchRemoteTargetState(root string, item *remoteWorkSavePlanItem, seenTargets map[string]string) error {
	absolute, err := safeDataPath(root, item.TargetPath)
	if err != nil {
		return err
	}
	if info, err := os.Stat(absolute); err == nil {
		item.TargetExists = true
		if info.IsDir() {
			item.TargetConflict = true
			item.TargetConflictReason = "target is a directory"
			item.Action, item.Status = "conflict", "target_conflict"
		} else {
			size := info.Size()
			item.TargetSizeBytes = &size
			if item.SizeBytes == nil || size == *item.SizeBytes {
				item.Action, item.Status = "skip", "local_exists"
			} else {
				item.TargetConflict = true
				item.TargetConflictReason = "target exists with a different size"
				item.Action, item.Status = "conflict", "target_conflict"
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		item.TargetConflict = true
		item.TargetConflictReason = err.Error()
		item.Action, item.Status = "conflict", "target_conflict"
	}
	applyRemoteFetchTargetState(item, seenTargets, "multiple remote files resolve to the same target path: ")
	return nil
}

func (s *Server) defaultRemoteFetchAction(ctx context.Context, item *remoteWorkSavePlanItem, workCode string) error {
	targetPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
	if err != nil {
		return err
	}
	if existingFileMatches(targetPath, item.SizeBytes) {
		item.Action, item.Status = "skip", "local_exists"
		return nil
	}
	if cachePath, ok := s.findRemoteCacheFile(ctx, item.RemoteSourceID, item.RemoteSourceCode, workCode, firstNonEmpty(item.RemotePath, item.Path), item.SizeBytes); ok {
		item.CachePath = filepath.ToSlash(cachePath)
		item.Action, item.Status = "cache_hit", "cache_hit"
		return nil
	}
	item.Action, item.Status = "cache_download", "remote_only"
	return nil
}

func (s *Server) buildLocalFetchPlanItems(inputs remoteFetchPlanInputs, seenTargets map[string]string) ([]remoteWorkSavePlanItem, error) {
	items := make([]remoteWorkSavePlanItem, 0, len(inputs.localFiles))
	for _, localFile := range inputs.localFiles {
		if len(inputs.selectedLocal) == 0 || !selectedLocalPathMatches(inputs.selectedLocal, localFile.Path) {
			continue
		}
		item, err := s.buildLocalFetchPlanItem(inputs, localFile, seenTargets)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Server) buildLocalFetchPlanItem(inputs remoteFetchPlanInputs, localFile remoteWorkSaveLocalFile, seenTargets map[string]string) (remoteWorkSavePlanItem, error) {
	path := trimLocalPathToWorkRoot(localFile.Path, inputs.localFiles)
	item := remoteWorkSavePlanItem{
		ItemKey: "local:" + localFile.Path, Path: path, Kind: mediaKindFromPath(localFile.Path),
		SizeBytes: localFile.SizeBytes, SourceKind: "local", LocalSourcePath: localFile.Path,
		TargetPath: filepath.ToSlash(joinRemotePath(inputs.saveRoot, path)), MediaItemID: localFile.MediaItemID,
		LocalPaths: []string{localFile.Path}, SourceOptions: []remoteFetchSourceOption{},
	}
	item.OriginalTargetPath = item.TargetPath
	decision := inputs.decisions[item.ItemKey]
	if err := applyRemoteFetchRename(&item, decision, inputs.saveRoot); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if _, err := safeDataPath(s.cfg.DataRoot, item.TargetPath); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if err := applyLocalFetchTargetState(s.cfg.DataRoot, &item, localFile.Path, seenTargets); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if err := s.applyRemoteFetchConflictDecision(&item, decision, inputs.saveRoot, seenTargets); err != nil {
		return remoteWorkSavePlanItem{}, err
	}
	if item.Action == "" {
		item.Action, item.Status = "copy_local", "copy_local"
	}
	return item, nil
}

func applyLocalFetchTargetState(root string, item *remoteWorkSavePlanItem, localPath string, seenTargets map[string]string) error {
	absolute, err := safeDataPath(root, item.TargetPath)
	if err != nil {
		return err
	}
	if info, err := os.Stat(absolute); err == nil {
		item.TargetExists = true
		if info.IsDir() {
			item.TargetConflict = true
			item.TargetConflictReason = "target is a directory"
			item.Action, item.Status = "conflict", "target_conflict"
		} else {
			size := info.Size()
			item.TargetSizeBytes = &size
			if filepath.ToSlash(localPath) == item.TargetPath {
				item.Action, item.Status = "skip", "local_source_already_target"
			} else {
				item.TargetConflict = true
				item.TargetConflictReason = "target exists"
				item.Action, item.Status = "conflict", "target_conflict"
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		item.TargetConflict = true
		item.TargetConflictReason = err.Error()
		item.Action, item.Status = "conflict", "target_conflict"
	}
	applyRemoteFetchTargetState(item, seenTargets, "multiple selected files resolve to the same target path: ")
	return nil
}
