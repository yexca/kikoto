package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

const cacheOrphanGracePeriod = 24 * time.Hour

type cacheReference struct {
	Available  bool
	WorkID     int64
	WorkCode   string
	SourceID   int64
	SourceCode string
	SourceName string
	Tracked    bool
	Local      bool
}

type cacheWorkOverview struct {
	GroupKey         string `json:"groupKey"`
	WorkID           int64  `json:"workId"`
	WorkCode         string `json:"workCode"`
	SourceID         int64  `json:"sourceId"`
	SourceCode       string `json:"sourceCode"`
	SourceName       string `json:"sourceName"`
	Files            int    `json:"files"`
	Bytes            int64  `json:"bytes"`
	ReferencedFiles  int    `json:"referencedFiles"`
	ReferencedBytes  int64  `json:"referencedBytes"`
	OrphanFiles      int    `json:"orphanFiles"`
	OrphanBytes      int64  `json:"orphanBytes"`
	EmptyDirectories int    `json:"emptyDirectories"`
	Tracked          bool   `json:"tracked"`
	Local            bool   `json:"local"`
}

type cacheOverview struct {
	ScannedAt         string              `json:"scannedAt"`
	MediaFiles        int                 `json:"mediaFiles"`
	MediaBytes        int64               `json:"mediaBytes"`
	ReferencedFiles   int                 `json:"referencedFiles"`
	ReferencedBytes   int64               `json:"referencedBytes"`
	OrphanFiles       int                 `json:"orphanFiles"`
	OrphanBytes       int64               `json:"orphanBytes"`
	ProtectedFiles    int                 `json:"protectedFiles"`
	MissingReferences int                 `json:"missingReferences"`
	EmptyDirectories  int                 `json:"emptyDirectories"`
	Works             []cacheWorkOverview `json:"works"`
}

type cacheMaintenanceScan struct {
	Overview         cacheOverview
	OrphanPaths      []string
	EmptyPaths       []string
	OrphanPathGroups map[string]string
	EmptyPathGroups  map[string]string
}

type cacheCleanupRequest struct {
	Mode      string   `json:"mode"`
	GroupKeys []string `json:"groupKeys"`
	WorkIDs   []int64  `json:"workIds"`
}

type cacheOrphanCleanupPayload struct {
	Files       []string `json:"files"`
	Directories []string `json:"directories"`
}

type cacheOrphanCleanupCheckpoint struct {
	CompletedKeys []string `json:"completedKeys"`
	DeletedFiles  int      `json:"deletedFiles"`
	FreedBytes    int64    `json:"freedBytes"`
}

type cacheMaintenanceResult struct {
	RunID  int64  `json:"runId"`
	JobID  int64  `json:"jobId"`
	Status string `json:"status"`
	Queued int    `json:"queued"`
}

func (s *Server) getCacheOverview(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	scan, err := s.scanManagedMediaCache(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, scan.Overview)
}

func (s *Server) cleanupOrphanCache(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	var request cacheCleanupRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	request.Mode = strings.ToLower(strings.TrimSpace(request.Mode))
	if request.Mode == "" {
		request.Mode = "orphans"
	}
	var result cacheMaintenanceResult
	var err error
	switch request.Mode {
	case "orphans":
		result, err = s.enqueueOrphanCacheCleanup(r.Context(), request.GroupKeys)
	case "works":
		result, err = s.enqueueWorkCacheCleanup(r.Context(), request.WorkIDs)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mode must be orphans or works"})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	status := http.StatusAccepted
	if result.Status == "succeeded" {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func (s *Server) scanManagedMediaCache(ctx context.Context) (cacheMaintenanceScan, error) {
	references, err := s.loadCacheReferences(ctx)
	if err != nil {
		return cacheMaintenanceScan{}, err
	}
	cacheRoot, err := filepath.Abs(s.cfg.CacheRoot)
	if err != nil {
		return cacheMaintenanceScan{}, err
	}
	mediaRoot := filepath.Join(cacheRoot, "media")
	result := cacheMaintenanceScan{
		Overview:    cacheOverview{ScannedAt: time.Now().UTC().Format(time.RFC3339), Works: []cacheWorkOverview{}},
		OrphanPaths: []string{}, EmptyPaths: []string{}, OrphanPathGroups: map[string]string{}, EmptyPathGroups: map[string]string{},
	}
	seenReferences := map[string]bool{}
	workRows := map[string]*cacheWorkOverview{}
	if _, statErr := os.Stat(mediaRoot); errors.Is(statErr, os.ErrNotExist) {
		result.Overview.MissingReferences = countAvailableCacheReferences(references)
		return result, nil
	} else if statErr != nil {
		return cacheMaintenanceScan{}, statErr
	}
	now := time.Now()
	err = filepath.WalkDir(mediaRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, relErr := filepath.Rel(cacheRoot, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		if entry.IsDir() {
			if path == mediaRoot {
				return nil
			}
			children, readErr := os.ReadDir(path)
			if readErr != nil {
				return readErr
			}
			if len(children) == 0 {
				result.Overview.EmptyDirectories++
				result.EmptyPaths = append(result.EmptyPaths, rel)
				workCode, sourceCode := cachePathIdentity(rel)
				row := ensureCacheWorkOverview(workRows, cacheReference{}, workCode, sourceCode)
				row.EmptyDirectories++
				result.EmptyPathGroups[rel] = row.GroupKey
			}
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		result.Overview.MediaFiles++
		result.Overview.MediaBytes += info.Size()
		reference, referenced := references[rel]
		if referenced {
			seenReferences[rel] = true
		}
		workCode, sourceCode := cachePathIdentity(rel)
		if reference.WorkCode != "" {
			workCode = reference.WorkCode
		}
		if reference.SourceCode != "" {
			sourceCode = reference.SourceCode
		}
		row := ensureCacheWorkOverview(workRows, reference, workCode, sourceCode)
		row.Files++
		row.Bytes += info.Size()
		if referenced && reference.Available {
			result.Overview.ReferencedFiles++
			result.Overview.ReferencedBytes += info.Size()
			row.ReferencedFiles++
			row.ReferencedBytes += info.Size()
			return nil
		}
		if now.Sub(info.ModTime()) < cacheOrphanGracePeriod {
			result.Overview.ProtectedFiles++
			return nil
		}
		result.Overview.OrphanFiles++
		result.Overview.OrphanBytes += info.Size()
		row.OrphanFiles++
		row.OrphanBytes += info.Size()
		result.OrphanPaths = append(result.OrphanPaths, rel)
		result.OrphanPathGroups[rel] = row.GroupKey
		return nil
	})
	if err != nil {
		return cacheMaintenanceScan{}, err
	}
	for path, reference := range references {
		if reference.Available && !seenReferences[path] {
			result.Overview.MissingReferences++
		}
	}
	for _, row := range workRows {
		result.Overview.Works = append(result.Overview.Works, *row)
	}
	sort.Slice(result.Overview.Works, func(i, j int) bool {
		if result.Overview.Works[i].OrphanBytes != result.Overview.Works[j].OrphanBytes {
			return result.Overview.Works[i].OrphanBytes > result.Overview.Works[j].OrphanBytes
		}
		return result.Overview.Works[i].Bytes > result.Overview.Works[j].Bytes
	})
	sort.Strings(result.OrphanPaths)
	sort.Slice(result.EmptyPaths, func(i, j int) bool { return len(result.EmptyPaths[i]) > len(result.EmptyPaths[j]) })
	return result, nil
}

func (s *Server) loadCacheReferences(ctx context.Context) (map[string]cacheReference, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.path, location.availability, work.id, work.primary_code, source.id, source.code, source.display_name,
			EXISTS (SELECT 1 FROM work_source_presence tracked WHERE tracked.work_id = work.id AND tracked.file_source_id = source.id AND tracked.presence_type = 'tracked' AND tracked.availability = 'available'),
			EXISTS (SELECT 1 FROM work_source_presence local_presence INNER JOIN file_source local_source ON local_source.id = local_presence.file_source_id WHERE local_presence.work_id = work.id AND local_presence.presence_type = 'local' AND local_presence.availability = 'available' AND local_source.source_type = 'local_folder')
		FROM media_file_location location
		INNER JOIN media_item item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		INNER JOIN file_source source ON source.id = location.file_source_id
		WHERE location.location_type = 'cache'
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]cacheReference{}
	for rows.Next() {
		var path, availability string
		var reference cacheReference
		if err := rows.Scan(&path, &availability, &reference.WorkID, &reference.WorkCode, &reference.SourceID, &reference.SourceCode, &reference.SourceName, &reference.Tracked, &reference.Local); err != nil {
			return nil, err
		}
		path = filepath.ToSlash(strings.TrimSpace(path))
		reference.Available = availability == "available"
		if current, ok := result[path]; !ok || (!current.Available && reference.Available) {
			result[path] = reference
		}
	}
	return result, rows.Err()
}

func countAvailableCacheReferences(references map[string]cacheReference) int {
	count := 0
	for _, reference := range references {
		if reference.Available {
			count++
		}
	}
	return count
}

func cachePathIdentity(relPath string) (string, string) {
	parts := strings.Split(filepath.ToSlash(relPath), "/")
	sourceName := "Unknown source"
	if len(parts) > 1 && parts[0] == "media" && strings.TrimSpace(parts[1]) != "" {
		sourceName = parts[1]
	}
	for _, part := range parts {
		code := normalizeDLsiteCode(part)
		if code != "" && strings.EqualFold(code, part) {
			return code, sourceName
		}
	}
	return "Unknown work", sourceName
}

func cacheGroupKey(workID int64, sourceCode string, workCode string) string {
	return fmt.Sprintf("%d:%s:%s", workID, strings.ToLower(strings.TrimSpace(sourceCode)), strings.ToUpper(strings.TrimSpace(workCode)))
}

func ensureCacheWorkOverview(rows map[string]*cacheWorkOverview, reference cacheReference, workCode string, sourceCode string) *cacheWorkOverview {
	groupKey := cacheGroupKey(reference.WorkID, sourceCode, workCode)
	if row := rows[groupKey]; row != nil {
		return row
	}
	sourceName := reference.SourceName
	if sourceName == "" {
		sourceName = sourceCode
	}
	row := &cacheWorkOverview{
		GroupKey: groupKey, WorkID: reference.WorkID, WorkCode: workCode,
		SourceID: reference.SourceID, SourceCode: sourceCode, SourceName: sourceName,
		Tracked: reference.Tracked, Local: reference.Local,
	}
	rows[groupKey] = row
	return row
}

func (s *Server) enqueueOrphanCacheCleanup(ctx context.Context, groupKeys []string) (cacheMaintenanceResult, error) {
	scan, err := s.scanManagedMediaCache(ctx)
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	selected := map[string]bool{}
	for _, key := range groupKeys {
		if key = strings.TrimSpace(key); key != "" {
			selected[key] = true
		}
	}
	payload := cacheOrphanCleanupPayload{Files: []string{}, Directories: []string{}}
	for _, path := range scan.OrphanPaths {
		if len(selected) == 0 || selected[scan.OrphanPathGroups[path]] {
			payload.Files = append(payload.Files, path)
		}
	}
	for _, path := range scan.EmptyPaths {
		if len(selected) == 0 || selected[scan.EmptyPathGroups[path]] {
			payload.Directories = append(payload.Directories, path)
		}
	}
	total := len(payload.Files) + len(payload.Directories)
	if total == 0 {
		return cacheMaintenanceResult{Status: "succeeded"}, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "cache_maintenance", "Maintain media cache", "Remove unreferenced managed media cache files after a safety grace period and prune empty directories.", map[string]any{"nodes": []map[string]string{{"id": "scan", "type": "select_media_items"}, {"id": "cleanup", "type": "cleanup_cache"}}})
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "cache_maintenance", "Maintain media cache", "queued", "manual", "delete_orphans", payload, map[string]any{"files": len(payload.Files), "directories": len(payload.Directories)})
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "scan", NodeType: "select_media_items", DisplayName: "Analyze media cache", Position: 1, Status: "succeeded", Input: map[string]any{"grace_hours": int(cacheOrphanGracePeriod.Hours())}, Output: scan.Overview}); err != nil {
		return cacheMaintenanceResult{}, err
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "cleanup", NodeType: "cleanup_cache", DisplayName: "Delete orphan cache files", Position: 2, Status: "queued", Input: payload})
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: "cache_orphan_cleanup", Status: "queued", Payload: payload, Checkpoint: cacheOrphanCleanupCheckpoint{CompletedKeys: []string{}}, Recoverable: true, MaxRetries: 3, ProgressTotal: total})
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return cacheMaintenanceResult{}, err
	}
	return cacheMaintenanceResult{RunID: runID, JobID: jobID, Status: "queued", Queued: total}, nil
}

func (s *Server) enqueueWorkCacheCleanup(ctx context.Context, workIDs []int64) (cacheMaintenanceResult, error) {
	unique := map[int64]bool{}
	for _, workID := range workIDs {
		if workID > 0 {
			unique[workID] = true
		}
	}
	if len(unique) == 0 {
		return cacheMaintenanceResult{}, fmt.Errorf("at least one work is required")
	}
	if len(unique) > 100 {
		return cacheMaintenanceResult{}, fmt.Errorf("at most 100 works can be cleaned at once")
	}
	targets := []mediaCleanupTargetRequest{}
	for workID := range unique {
		rows, err := s.db.QueryContext(ctx, `
			SELECT location.id
			FROM media_file_location AS location
			INNER JOIN media_item AS item ON item.id = location.media_item_id
			WHERE item.work_id = ? AND location.location_type = 'cache' AND location.availability = 'available'
			ORDER BY location.id
		`, workID)
		if err != nil {
			return cacheMaintenanceResult{}, err
		}
		for rows.Next() {
			var locationID int64
			if err := rows.Scan(&locationID); err != nil {
				_ = rows.Close()
				return cacheMaintenanceResult{}, err
			}
			targets = append(targets, mediaCleanupTargetRequest{Kind: "cache", LocationID: locationID})
		}
		if err := rows.Close(); err != nil {
			return cacheMaintenanceResult{}, err
		}
	}
	if len(targets) == 0 {
		return cacheMaintenanceResult{Status: "succeeded"}, nil
	}
	if len(targets) > maxMediaCleanupTargets {
		return cacheMaintenanceResult{}, fmt.Errorf("selected works contain more than %d cache locations", maxMediaCleanupTargets)
	}
	result, err := s.enqueueMediaLocationCleanup(ctx, targets)
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	return cacheMaintenanceResult{RunID: result.RunID, JobID: result.JobID, Status: result.Status, Queued: result.Queued}, nil
}

func (s *Server) executeCacheOrphanCleanupJob(ctx context.Context, job workflowJobRecord) error {
	var payload cacheOrphanCleanupPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	checkpoint := cacheOrphanCleanupCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	completed := map[string]bool{}
	for _, key := range checkpoint.CompletedKeys {
		completed[key] = true
	}
	total := len(payload.Files) + len(payload.Directories)
	progress := len(checkpoint.CompletedKeys)
	for _, relPath := range payload.Files {
		key := "file:" + relPath
		if completed[key] {
			continue
		}
		deleted, bytes, err := s.deleteOrphanCacheFile(ctx, relPath)
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		if deleted {
			checkpoint.DeletedFiles++
			checkpoint.FreedBytes += bytes
		}
		checkpoint.CompletedKeys = append(checkpoint.CompletedKeys, key)
		completed[key] = true
		progress++
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "cleanup", checkpoint, progress, total)
	}
	for _, relPath := range payload.Directories {
		key := "directory:" + relPath
		if completed[key] {
			continue
		}
		if err := s.removeEmptyManagedCacheDirectory(relPath); err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		checkpoint.CompletedKeys = append(checkpoint.CompletedKeys, key)
		progress++
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "cleanup", checkpoint, progress, total)
	}
	output := mustJSON(map[string]any{"deleted_files": checkpoint.DeletedFiles, "freed_bytes": checkpoint.FreedBytes})
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", output, job.NodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_job SET status = 'succeeded', progress_current = progress_total, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", output, job.RunID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) deleteOrphanCacheFile(ctx context.Context, relPath string) (bool, int64, error) {
	relPath = filepath.ToSlash(strings.TrimSpace(relPath))
	if !strings.HasPrefix(relPath, "media/") {
		return false, 0, fmt.Errorf("cache maintenance path is outside managed media cache")
	}
	var available int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM media_file_location WHERE location_type = 'cache' AND availability = 'available' AND path = ?", relPath).Scan(&available); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, 0, err
	}
	if available > 0 {
		return false, 0, nil
	}
	targetPath, err := safeCachePath(s.cfg.CacheRoot, relPath)
	if err != nil {
		return false, 0, err
	}
	info, err := os.Lstat(targetPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.IsDir() {
		return false, 0, fmt.Errorf("refusing to delete non-file cache path")
	}
	if time.Since(info.ModTime()) < cacheOrphanGracePeriod {
		return false, 0, nil
	}
	if err := os.Remove(targetPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, 0, err
	}
	_ = pruneEmptyCacheParents(s.cfg.CacheRoot, filepath.Dir(targetPath))
	return true, info.Size(), nil
}

func (s *Server) removeEmptyManagedCacheDirectory(relPath string) error {
	relPath = filepath.ToSlash(strings.TrimSpace(relPath))
	if !strings.HasPrefix(relPath, "media/") {
		return fmt.Errorf("cache maintenance directory is outside managed media cache")
	}
	target, err := safeCachePath(s.cfg.CacheRoot, relPath)
	if err != nil {
		return err
	}
	if err := os.Remove(target); err != nil {
		if errors.Is(err, os.ErrNotExist) || isDirectoryNotEmpty(err) {
			return nil
		}
		return err
	}
	return pruneEmptyCacheParents(s.cfg.CacheRoot, filepath.Dir(target))
}

func pruneEmptyCacheParents(cacheRoot string, startDirectory string) error {
	mediaRoot, err := filepath.Abs(filepath.Join(cacheRoot, "media"))
	if err != nil {
		return err
	}
	current, err := filepath.Abs(startDirectory)
	if err != nil {
		return err
	}
	if !isPathWithinRoot(mediaRoot, current) {
		return nil
	}
	for current != mediaRoot {
		if err := os.Remove(current); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				current = filepath.Dir(current)
				continue
			}
			if isDirectoryNotEmpty(err) {
				return nil
			}
			return err
		}
		current = filepath.Dir(current)
	}
	return nil
}

func isDirectoryNotEmpty(err error) bool {
	return errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) || strings.Contains(strings.ToLower(err.Error()), "not empty")
}
