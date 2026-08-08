package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

const (
	defaultRemoteSaveRootTemplate = "/data/<source_code>/<code_prefix>_<code_group>/<work_code>"
	remoteFetchRootReadmeName     = "README.md"
	remoteFetchRootMarkerMaxBytes = 4096
)

const remoteFetchRootReadme = `# Kikoto Fetch-managed folder

## English

This folder is managed by Kikoto Fetch. Do not manually add, move, rename, or modify works here. Changes in this folder do not trigger automatic filesystem monitoring and may conflict with Fetch operations. Store manually managed works elsewhere in the Kikoto data directory.

## 简体中文

此文件夹由 Kikoto Fetch 管理。请勿在此手动添加、移动、重命名或修改作品。此文件夹中的更改不会触发自动文件系统监视，并且可能与 Fetch 操作发生冲突。请将手动管理的作品存放在 Kikoto 数据目录中的其他位置。

## 繁體中文

此資料夾由 Kikoto Fetch 管理。請勿在此手動新增、移動、重新命名或修改作品。此資料夾中的變更不會觸發自動檔案系統監視，並且可能與 Fetch 操作發生衝突。請將手動管理的作品存放在 Kikoto 資料目錄中的其他位置。

## 日本語

このフォルダーは Kikoto Fetch によって管理されています。作品を手動で追加、移動、名前変更、または編集しないでください。このフォルダー内の変更は自動ファイルシステム監視の対象外であり、Fetch 処理と競合する可能性があります。手動で管理する作品は、Kikoto のデータディレクトリ内の別の場所に保存してください。

## 한국어

이 폴더는 Kikoto Fetch에서 관리합니다. 작품을 수동으로 추가, 이동, 이름 변경 또는 수정하지 마세요. 이 폴더의 변경 사항은 자동 파일 시스템 감시 대상이 아니며 Fetch 작업과 충돌할 수 있습니다. 직접 관리하는 작품은 Kikoto 데이터 디렉터리의 다른 위치에 저장하세요.
`

type remoteFetchRootReview struct {
	RootPath string `json:"rootPath"`
	Status   string `json:"status"`
	Conflict bool   `json:"conflict"`
	Message  string `json:"message"`
}

type remoteFetchRootMarker struct {
	Version    int    `json:"version"`
	ManagedBy  string `json:"managed_by"`
	Purpose    string `json:"purpose"`
	SourceCode string `json:"source_code"`
}

func (s *Server) attachRemoteFetchRootReview(ctx context.Context, source remoteSourceForUse, plan *remoteWorkSavePlan) error {
	review, err := s.inspectRemoteFetchRoot(ctx, source, plan.SaveRoot)
	if err != nil {
		return err
	}
	plan.FetchRoot = review
	if review.Conflict {
		plan.Summary.Conflict++
	}
	return nil
}

func (s *Server) inspectRemoteFetchRoot(ctx context.Context, source remoteSourceForUse, saveRoot string) (remoteFetchRootReview, error) {
	managedRoot, ok := s.remoteFetchManagedRoot(ctx, source)
	if !ok || !fetchPathWithinRoot(managedRoot, saveRoot) {
		return remoteFetchRootReview{Status: "not_applicable"}, nil
	}
	review := remoteFetchRootReview{RootPath: managedRoot, Status: "ready"}
	absRoot, err := safeDataPath(s.cfg.DataRoot, managedRoot)
	if err != nil {
		return remoteFetchRootConflict(managedRoot, "The configured Fetch folder is not a safe path below the Kikoto data directory."), nil
	}
	unsafe, err := fetchRootPathIsUnsafe(s.cfg.DataRoot, absRoot)
	if err != nil {
		return review, err
	}
	if unsafe {
		return remoteFetchRootConflict(managedRoot, "The Fetch folder path contains a symbolic link, junction, reparse point, or non-directory parent. Choose a different Fetch location."), nil
	}
	info, err := os.Lstat(absRoot)
	if errors.Is(err, os.ErrNotExist) {
		return review, nil
	}
	if err != nil {
		return review, err
	}
	if unsafeFetchStagingEntry(info) || !info.IsDir() {
		return remoteFetchRootConflict(managedRoot, "The Fetch folder path already exists but is not a regular directory. Choose a different Fetch location."), nil
	}

	marker, markerExists, markerErr := readRemoteFetchRootMarker(absRoot)
	if markerErr != nil {
		return remoteFetchRootConflict(managedRoot, "The Fetch folder contains an invalid Kikoto ownership marker. Do not use this directory until the marker conflict has been resolved."), nil
	}
	if markerExists {
		if remoteFetchRootMarkerMatches(marker, source.Code) {
			review.Status = "managed"
			return review, nil
		}
		return remoteFetchRootConflict(managedRoot, "The Fetch folder is claimed by a different remote source. Do not use this directory for this source."), nil
	}

	empty, err := directoryIsEmpty(absRoot)
	if err != nil {
		return review, err
	}
	if empty {
		return review, nil
	}
	legacyManaged, err := s.legacyRemoteFetchRootIsManaged(ctx, source, absRoot)
	if err != nil {
		return review, err
	}
	if legacyManaged {
		review.Status = "legacy_managed"
		return review, nil
	}
	return remoteFetchRootConflict(managedRoot, "This Fetch folder already exists and is not managed by Kikoto. Do not use it for manually managed works. Move or rename the existing directory before Fetching."), nil
}

func (s *Server) ensureRemoteFetchRootClaim(ctx context.Context, source remoteSourceForUse, saveRoot string) (remoteFetchRootReview, error) {
	review, err := s.inspectRemoteFetchRoot(ctx, source, saveRoot)
	if err != nil || review.Conflict || review.Status == "not_applicable" {
		return review, err
	}
	absRoot, err := safeDataPath(s.cfg.DataRoot, review.RootPath)
	if err != nil {
		return review, err
	}
	if err := os.MkdirAll(absRoot, 0o755); err != nil {
		return review, err
	}
	marker, markerExists, markerErr := readRemoteFetchRootMarker(absRoot)
	if markerErr != nil {
		return remoteFetchRootConflict(review.RootPath, "The Fetch folder contains an invalid Kikoto ownership marker. Do not use this directory until the marker conflict has been resolved."), nil
	}
	if markerExists {
		if !remoteFetchRootMarkerMatches(marker, source.Code) {
			return remoteFetchRootConflict(review.RootPath, "The Fetch folder is claimed by a different remote source. Do not use this directory for this source."), nil
		}
	} else {
		empty, emptyErr := directoryIsEmpty(absRoot)
		if emptyErr != nil {
			return review, emptyErr
		}
		if !empty {
			if review.Status != "legacy_managed" {
				return remoteFetchRootConflict(review.RootPath, "This Fetch folder already exists and is not managed by Kikoto. Do not use it for manually managed works. Move or rename the existing directory before Fetching."), nil
			}
			legacyManaged, legacyErr := s.legacyRemoteFetchRootIsManaged(ctx, source, absRoot)
			if legacyErr != nil {
				return review, legacyErr
			}
			if !legacyManaged {
				return remoteFetchRootConflict(review.RootPath, "The Fetch folder contents changed while Fetch was being prepared. Review the directory before retrying."), nil
			}
		}
		if err := createRemoteFetchRootMarker(absRoot, source.Code); err != nil {
			if !errors.Is(err, os.ErrExist) {
				return review, err
			}
			marker, markerExists, markerErr = readRemoteFetchRootMarker(absRoot)
			if markerErr != nil || !markerExists || !remoteFetchRootMarkerMatches(marker, source.Code) {
				return remoteFetchRootConflict(review.RootPath, "The Fetch folder ownership changed while Fetch was being prepared. Review the directory before retrying."), nil
			}
		}
	}
	if err := writeRemoteFetchRootReadme(absRoot); err != nil {
		return review, err
	}
	review.Status = "managed"
	return review, nil
}

func remoteFetchRootConflict(root string, message string) remoteFetchRootReview {
	return remoteFetchRootReview{RootPath: root, Status: "conflict", Conflict: true, Message: message}
}

func remoteFetchRootMarkerMatches(marker remoteFetchRootMarker, sourceCode string) bool {
	return marker.Version == localfs.FetchRootMarkerVersion &&
		marker.ManagedBy == "kikoto" &&
		marker.Purpose == "remote_fetch" &&
		strings.EqualFold(marker.SourceCode, sourceCode)
}

func (s *Server) legacyRemoteFetchRootIsManaged(ctx context.Context, source remoteSourceForUse, absRoot string) (bool, error) {
	targets, err := s.loadLegacyRemoteFetchTargets(ctx, source.ID)
	if err != nil {
		return false, err
	}
	exactTargets, targetAncestors := legacyRemoteFetchTargetPaths(s.cfg.DataRoot, absRoot, targets)
	if len(exactTargets) == 0 {
		return false, nil
	}
	verified, foundTarget, err := verifyLegacyRemoteFetchRoot(absRoot, exactTargets, targetAncestors)
	if err != nil {
		return false, err
	}
	return verified && foundTarget, nil
}

func (s *Server) loadLegacyRemoteFetchTargets(ctx context.Context, sourceID int64) ([]string, error) {
	targets := map[string]bool{}
	rows, err := s.db.QueryContext(ctx, `
		SELECT root_path
		FROM work_folder_location
		WHERE role = 'managed_fetch'
			AND state = 'active'
			AND origin_source_id = ?
		ORDER BY id ASC
	`, sourceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var target string
		if err := rows.Scan(&target); err != nil {
			_ = rows.Close()
			return nil, err
		}
		target = strings.TrimSpace(target)
		if target != "" {
			targets[target] = true
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	rows, err = s.db.QueryContext(ctx, `
		SELECT run.input_json, plan.output_json
		FROM workflow_run AS run
		INNER JOIN workflow_node_run AS plan
			ON plan.workflow_run_id = run.id
			AND plan.node_id = 'plan'
			AND plan.status = 'succeeded'
		WHERE run.workflow_code = 'remote_work_fetch'
			AND run.status = 'succeeded'
			AND CASE
				WHEN json_valid(run.input_json)
				THEN CAST(json_extract(run.input_json, '$.source_id') AS INTEGER)
				ELSE 0
			END = ?
			AND CASE
				WHEN json_valid(plan.output_json)
				THEN CAST(json_extract(plan.output_json, '$.sourceId') AS INTEGER)
				ELSE 0
			END = ?
		ORDER BY run.id ASC, plan.id ASC
	`, sourceID, sourceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var inputJSON, outputJSON string
		if err := rows.Scan(&inputJSON, &outputJSON); err != nil {
			_ = rows.Close()
			return nil, err
		}
		var input struct {
			SourceID int64 `json:"source_id"`
		}
		var output struct {
			SourceID int64  `json:"sourceId"`
			SaveRoot string `json:"saveRoot"`
		}
		if json.Unmarshal([]byte(inputJSON), &input) != nil || json.Unmarshal([]byte(outputJSON), &output) != nil {
			continue
		}
		if input.SourceID != sourceID || output.SourceID != sourceID {
			continue
		}
		target := strings.TrimSpace(output.SaveRoot)
		if target != "" {
			targets[target] = true
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	result := make([]string, 0, len(targets))
	for target := range targets {
		result = append(result, target)
	}
	sort.Strings(result)
	return result, nil
}

func legacyRemoteFetchTargetPaths(dataRoot string, absRoot string, targets []string) (map[string]bool, map[string]bool) {
	exactTargets := map[string]bool{}
	targetAncestors := map[string]bool{}
	for _, target := range targets {
		absTarget, err := safeDataPath(dataRoot, target)
		if err != nil {
			continue
		}
		relative, err := filepath.Rel(absRoot, absTarget)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		relative = filepath.Clean(relative)
		exactTargets[relative] = true
		for parent := filepath.Dir(relative); parent != "."; parent = filepath.Dir(parent) {
			targetAncestors[parent] = true
		}
	}
	return exactTargets, targetAncestors
}

func verifyLegacyRemoteFetchRoot(absRoot string, exactTargets map[string]bool, targetAncestors map[string]bool) (bool, bool, error) {
	foundTarget := false
	var verifyDirectory func(string, string) (bool, error)
	verifyDirectory = func(directory string, relativeDirectory string) (bool, error) {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return false, err
		}
		for _, entry := range entries {
			entryPath := filepath.Join(directory, entry.Name())
			entryInfo, err := os.Lstat(entryPath)
			if err != nil {
				return false, err
			}
			if unsafeFetchStagingEntry(entryInfo) {
				return false, nil
			}
			relative := entry.Name()
			if relativeDirectory != "" {
				relative = filepath.Join(relativeDirectory, entry.Name())
			}
			if relativeDirectory == "" && entry.Name() == remoteFetchRootReadmeName {
				if !entryInfo.Mode().IsRegular() {
					return false, nil
				}
				continue
			}
			if exactTargets[relative] {
				if !entryInfo.IsDir() {
					return false, nil
				}
				foundTarget = true
				continue
			}
			if !targetAncestors[relative] || !entryInfo.IsDir() {
				return false, nil
			}
			verified, err := verifyDirectory(entryPath, relative)
			if err != nil || !verified {
				return verified, err
			}
		}
		return true, nil
	}
	verified, err := verifyDirectory(absRoot, "")
	return verified, foundTarget, err
}

func (s *Server) remoteFetchManagedRoot(ctx context.Context, source remoteSourceForUse) (string, bool) {
	template := strings.TrimSpace(source.Config.SaveRootTemplate)
	if template == "" {
		template = s.settingStringContext(ctx, "remote_save_root_template", defaultRemoteSaveRootTemplate)
	}
	return remoteFetchManagedRootFromTemplate(template, source.Code)
}

func remoteFetchManagedRootFromTemplate(template string, sourceCode string) (string, bool) {
	value := filepath.ToSlash(strings.TrimSpace(template))
	value = strings.TrimPrefix(value, "/data/")
	value = strings.TrimPrefix(value, "data/")
	value = strings.Trim(value, "/")
	if value == "" {
		return "", false
	}
	parts := strings.Split(value, "/")
	resolved := make([]string, 0, len(parts))
	for _, part := range parts {
		if containsRemoteFetchWorkToken(part) {
			return "", false
		}
		if containsRemoteFetchSourceToken(part) {
			part = replaceRemoteFetchSourceTokens(part, sourceCode)
			if strings.ContainsAny(part, "<>") || strings.TrimSpace(part) == "" {
				return "", false
			}
			resolved = append(resolved, part)
			root := filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.Join(resolved, "/"))))
			if root == "." || root == ".." || strings.HasPrefix(root, "../") {
				return "", false
			}
			return strings.Trim(root, "/"), true
		}
		if strings.ContainsAny(part, "<>") {
			return "", false
		}
		resolved = append(resolved, part)
	}
	return "", false
}

// source_name is retained as a compatibility alias for templates saved before
// source_code became the canonical token. Both names always resolve to the
// immutable file_source.code, never to its display name.
func containsRemoteFetchSourceToken(value string) bool {
	return strings.Contains(value, "<source_code>") || strings.Contains(value, "<source_name>")
}

func replaceRemoteFetchSourceTokens(value string, sourceCode string) string {
	return strings.NewReplacer(
		"<source_code>", sourceCode,
		"<source_name>", sourceCode,
	).Replace(value)
}

func containsRemoteFetchWorkToken(value string) bool {
	return strings.Contains(value, "<work_code>") || strings.Contains(value, "<code_prefix>") || strings.Contains(value, "<code_group>")
}

func fetchPathWithinRoot(root string, path string) bool {
	root = strings.ToLower(strings.Trim(filepath.ToSlash(filepath.Clean(filepath.FromSlash(root))), "/"))
	path = strings.ToLower(strings.Trim(filepath.ToSlash(filepath.Clean(filepath.FromSlash(path))), "/"))
	return root != "" && (path == root || strings.HasPrefix(path, root+"/"))
}

func (s *Server) configuredRemoteFetchWatchRoots(ctx context.Context) ([]string, error) {
	defaultTemplate := s.settingStringContext(ctx, "remote_save_root_template", defaultRemoteSaveRootTemplate)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, code, config_json
		FROM file_source
		WHERE source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
		ORDER BY id ASC
	`)
	if err != nil {
		return nil, err
	}
	type configuredSource struct {
		id         int64
		code       string
		configJSON string
	}
	sources := []configuredSource{}
	for rows.Next() {
		var source configuredSource
		if err := rows.Scan(&source.id, &source.code, &source.configJSON); err != nil {
			_ = rows.Close()
			return nil, err
		}
		sources = append(sources, source)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	roots := []string{}
	seen := map[string]bool{}
	for _, configured := range sources {
		var sourceConfig fileSourceConfig
		_ = json.Unmarshal([]byte(configured.configJSON), &sourceConfig)
		template := strings.TrimSpace(sourceConfig.SaveRootTemplate)
		if template == "" {
			template = defaultTemplate
		}
		root, ok := remoteFetchManagedRootFromTemplate(template, configured.code)
		if !ok {
			continue
		}
		review, err := s.inspectRemoteFetchRoot(ctx, remoteSourceForUse{ID: configured.id, Code: configured.code, Config: sourceConfig}, root)
		if err != nil {
			return nil, err
		}
		if review.Conflict || (review.Status != "managed" && review.Status != "legacy_managed") {
			continue
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, root)
		if err != nil {
			continue
		}
		key := strings.ToLower(filepath.Clean(absolute))
		if !seen[key] {
			seen[key] = true
			roots = append(roots, absolute)
		}
	}
	sort.Slice(roots, func(i, j int) bool { return strings.ToLower(roots[i]) < strings.ToLower(roots[j]) })
	return roots, nil
}

func fetchRootPathIsUnsafe(dataRoot string, targetRoot string) (bool, error) {
	absDataRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return false, err
	}
	absTargetRoot, err := filepath.Abs(targetRoot)
	if err != nil {
		return false, err
	}
	relative, err := filepath.Rel(absDataRoot, absTargetRoot)
	if err != nil {
		return false, err
	}
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return true, nil
	}
	current := absDataRoot
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if unsafeFetchStagingEntry(info) || !info.IsDir() {
			return true, nil
		}
	}
	return false, nil
}

func readRemoteFetchRootMarker(root string) (remoteFetchRootMarker, bool, error) {
	path := filepath.Join(root, localfs.FetchRootMarkerName)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return remoteFetchRootMarker{}, false, nil
	}
	if err != nil {
		return remoteFetchRootMarker{}, false, err
	}
	if unsafeFetchStagingEntry(info) || !info.Mode().IsRegular() || info.Size() > remoteFetchRootMarkerMaxBytes {
		return remoteFetchRootMarker{}, true, errors.New("invalid Fetch root marker")
	}
	file, err := os.Open(path)
	if err != nil {
		return remoteFetchRootMarker{}, true, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, remoteFetchRootMarkerMaxBytes+1))
	if err != nil || len(data) > remoteFetchRootMarkerMaxBytes {
		return remoteFetchRootMarker{}, true, errors.New("invalid Fetch root marker")
	}
	var marker remoteFetchRootMarker
	if err := json.Unmarshal(data, &marker); err != nil {
		return remoteFetchRootMarker{}, true, err
	}
	return marker, true, nil
}

func createRemoteFetchRootMarker(root string, sourceCode string) error {
	marker := remoteFetchRootMarker{Version: localfs.FetchRootMarkerVersion, ManagedBy: "kikoto", Purpose: "remote_fetch", SourceCode: sourceCode}
	data, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeNewFetchRootFile(filepath.Join(root, localfs.FetchRootMarkerName), data)
}

func writeRemoteFetchRootReadme(root string) error {
	path := filepath.Join(root, remoteFetchRootReadmeName)
	if _, err := os.Lstat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	err := writeNewFetchRootFile(path, []byte(remoteFetchRootReadme))
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	return err
}

func writeNewFetchRootFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		_ = file.Close()
		if remove {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	remove = false
	return nil
}

func directoryIsEmpty(path string) (bool, error) {
	directory, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer directory.Close()
	_, err = directory.Readdirnames(1)
	if errors.Is(err, io.EOF) {
		return true, nil
	}
	return false, err
}
