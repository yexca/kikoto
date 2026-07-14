package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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
	WorkCode   string
	SourceID   int64
	SourceName string
	Tracked    bool
	Local      bool
}

type cacheWorkOverview struct {
	WorkCode    string `json:"workCode"`
	SourceID    int64  `json:"sourceId"`
	SourceName  string `json:"sourceName"`
	Files       int    `json:"files"`
	Bytes       int64  `json:"bytes"`
	OrphanFiles int    `json:"orphanFiles"`
	OrphanBytes int64  `json:"orphanBytes"`
	Tracked     bool   `json:"tracked"`
	Local       bool   `json:"local"`
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
	Overview    cacheOverview
	OrphanPaths []string
	EmptyPaths  []string
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
	result, err := s.enqueueOrphanCacheCleanup(r.Context())
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
	result := cacheMaintenanceScan{Overview: cacheOverview{ScannedAt: time.Now().UTC().Format(time.RFC3339), Works: []cacheWorkOverview{}}, OrphanPaths: []string{}, EmptyPaths: []string{}}
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
		workCode, sourceName := cachePathIdentity(rel)
		if reference.WorkCode != "" {
			workCode = reference.WorkCode
		}
		if reference.SourceName != "" {
			sourceName = reference.SourceName
		}
		key := fmt.Sprintf("%d:%s:%s", reference.SourceID, sourceName, workCode)
		row := workRows[key]
		if row == nil {
			row = &cacheWorkOverview{WorkCode: workCode, SourceID: reference.SourceID, SourceName: sourceName, Tracked: reference.Tracked, Local: reference.Local}
			workRows[key] = row
		}
		row.Files++
		row.Bytes += info.Size()
		if referenced && reference.Available {
			result.Overview.ReferencedFiles++
			result.Overview.ReferencedBytes += info.Size()
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
		SELECT location.path, location.availability, work.primary_code, source.id, source.display_name,
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
		if err := rows.Scan(&path, &availability, &reference.WorkCode, &reference.SourceID, &reference.SourceName, &reference.Tracked, &reference.Local); err != nil {
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

func (s *Server) enqueueOrphanCacheCleanup(ctx context.Context) (cacheMaintenanceResult, error) {
	scan, err := s.scanManagedMediaCache(ctx)
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	payload := cacheOrphanCleanupPayload{Files: scan.OrphanPaths, Directories: scan.EmptyPaths}
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
