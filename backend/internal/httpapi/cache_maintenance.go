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
	walker := managedCacheWalker{
		cacheRoot: cacheRoot, mediaRoot: mediaRoot, now: time.Now(), references: references,
		seenReferences: seenReferences, workRows: workRows, result: &result,
	}
	err = filepath.WalkDir(mediaRoot, walker.visit)
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

type managedCacheWalker struct {
	cacheRoot, mediaRoot string
	now                  time.Time
	references           map[string]cacheReference
	seenReferences       map[string]bool
	workRows             map[string]*cacheWorkOverview
	result               *cacheMaintenanceScan
}

func (walker *managedCacheWalker) visit(path string, entry os.DirEntry, walkErr error) error {
	if walkErr != nil {
		return walkErr
	}
	info, err := entry.Info()
	if err != nil {
		return err
	}
	if unsafeFetchStagingEntry(info) {
		if entry.IsDir() {
			return filepath.SkipDir
		}
		return nil
	}
	rel, err := filepath.Rel(walker.cacheRoot, path)
	if err != nil {
		return err
	}
	rel = filepath.ToSlash(rel)
	if entry.IsDir() {
		return walker.visitDirectory(path, rel)
	}
	walker.visitFile(rel, info)
	return nil
}

func (walker *managedCacheWalker) visitDirectory(path, rel string) error {
	if path == walker.mediaRoot {
		return nil
	}
	children, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	if len(children) != 0 {
		return nil
	}
	walker.result.Overview.EmptyDirectories++
	walker.result.EmptyPaths = append(walker.result.EmptyPaths, rel)
	workCode, sourceCode := cachePathIdentity(rel)
	row := ensureCacheWorkOverview(walker.workRows, cacheReference{}, workCode, sourceCode)
	row.EmptyDirectories++
	walker.result.EmptyPathGroups[rel] = row.GroupKey
	return nil
}

func (walker *managedCacheWalker) visitFile(rel string, info os.FileInfo) {
	walker.result.Overview.MediaFiles++
	walker.result.Overview.MediaBytes += info.Size()
	reference, referenced := walker.references[rel]
	if referenced {
		walker.seenReferences[rel] = true
	}
	workCode, sourceCode := cachePathIdentity(rel)
	if reference.WorkCode != "" {
		workCode = reference.WorkCode
	}
	if reference.SourceCode != "" {
		sourceCode = reference.SourceCode
	}
	row := ensureCacheWorkOverview(walker.workRows, reference, workCode, sourceCode)
	row.Files++
	row.Bytes += info.Size()
	if referenced && reference.Available {
		walker.result.Overview.ReferencedFiles++
		walker.result.Overview.ReferencedBytes += info.Size()
		row.ReferencedFiles++
		row.ReferencedBytes += info.Size()
		return
	}
	if walker.now.Sub(info.ModTime()) < cacheOrphanGracePeriod {
		walker.result.Overview.ProtectedFiles++
		return
	}
	walker.result.Overview.OrphanFiles++
	walker.result.Overview.OrphanBytes += info.Size()
	row.OrphanFiles++
	row.OrphanBytes += info.Size()
	walker.result.OrphanPaths = append(walker.result.OrphanPaths, rel)
	walker.result.OrphanPathGroups[rel] = row.GroupKey
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
	payload := selectCacheOrphanCleanupPayload(scan, groupKeys)
	total := len(payload.Files) + len(payload.Directories)
	if total == 0 {
		return cacheMaintenanceResult{Status: "succeeded"}, nil
	}
	return s.insertCacheOrphanCleanupWorkflow(ctx, payload, scan.Overview, total)
}

func selectCacheOrphanCleanupPayload(scan cacheMaintenanceScan, groupKeys []string) cacheOrphanCleanupPayload {
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
	return payload
}

func (s *Server) insertCacheOrphanCleanupWorkflow(ctx context.Context, payload cacheOrphanCleanupPayload, overview cacheOverview, total int) (cacheMaintenanceResult, error) {
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
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "scan", NodeType: "select_media_items", DisplayName: "Analyze media cache", Position: 1, Status: "succeeded", Input: map[string]any{"grace_hours": int(cacheOrphanGracePeriod.Hours())}, Output: overview}); err != nil {
		return cacheMaintenanceResult{}, err
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "cleanup", NodeType: "cleanup_cache", DisplayName: "Delete orphan cache files", Position: 2, Status: "queued", Input: payload})
	if err != nil {
		return cacheMaintenanceResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: "cache_orphan_cleanup", Status: "queued", Priority: workflow.JobPriorityUserInitiated, ResourceKey: "media:cleanup", Payload: payload, Checkpoint: cacheOrphanCleanupCheckpoint{CompletedKeys: []string{}}, Recoverable: true, MaxRetries: 3, ProgressTotal: total})
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
	payload, checkpoint, err := decodeCacheOrphanCleanupExecution(job)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	statusCtx := context.WithoutCancel(ctx)
	finishCancelled := func() error {
		return s.finishCancelledMediaCleanup(statusCtx, job)
	}
	total := len(payload.Files) + len(payload.Directories)
	completed := cacheCleanupCompletedKeys(checkpoint)
	if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
		return err
	}
	progress, stopped, err := s.processCacheCleanupFiles(ctx, statusCtx, job, payload.Files, &checkpoint, completed, total, finishCancelled)
	if stopped {
		return err
	}
	if stopped, err := s.processCacheCleanupDirectories(ctx, statusCtx, job, payload.Directories, &checkpoint, completed, progress, total, finishCancelled); stopped {
		return err
	}
	if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
		return err
	}
	return s.finishCacheOrphanCleanup(statusCtx, job, checkpoint, finishCancelled)
}

func decodeCacheOrphanCleanupExecution(job workflowJobRecord) (cacheOrphanCleanupPayload, cacheOrphanCleanupCheckpoint, error) {
	var payload cacheOrphanCleanupPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		return cacheOrphanCleanupPayload{}, cacheOrphanCleanupCheckpoint{}, err
	}
	checkpoint := cacheOrphanCleanupCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		return cacheOrphanCleanupPayload{}, cacheOrphanCleanupCheckpoint{}, err
	}
	return payload, checkpoint, nil
}

func cacheCleanupCompletedKeys(checkpoint cacheOrphanCleanupCheckpoint) map[string]bool {
	completed := make(map[string]bool, len(checkpoint.CompletedKeys))
	for _, key := range checkpoint.CompletedKeys {
		completed[key] = true
	}
	return completed
}

func (s *Server) processCacheCleanupFiles(
	ctx context.Context,
	statusCtx context.Context,
	job workflowJobRecord,
	paths []string,
	checkpoint *cacheOrphanCleanupCheckpoint,
	completed map[string]bool,
	total int,
	finishCancelled func() error,
) (int, bool, error) {
	progress := len(checkpoint.CompletedKeys)
	for _, relPath := range paths {
		key := "file:" + relPath
		if completed[key] {
			continue
		}
		if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
			return progress, true, err
		}
		deleted, bytes, err := s.deleteOrphanCacheFile(ctx, relPath)
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return progress, true, err
		}
		if deleted {
			checkpoint.DeletedFiles++
			checkpoint.FreedBytes += bytes
		}
		progress++
		if err := s.recordCacheCleanupCheckpoint(statusCtx, job, checkpoint, completed, key, progress, total); err != nil {
			return progress, true, err
		}
	}
	return progress, false, nil
}

func (s *Server) processCacheCleanupDirectories(
	ctx context.Context,
	statusCtx context.Context,
	job workflowJobRecord,
	paths []string,
	checkpoint *cacheOrphanCleanupCheckpoint,
	completed map[string]bool,
	progress int,
	total int,
	finishCancelled func() error,
) (bool, error) {
	for _, relPath := range paths {
		key := "directory:" + relPath
		if completed[key] {
			continue
		}
		if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
			return true, err
		}
		if err := s.removeEmptyManagedCacheDirectory(relPath); err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return true, err
		}
		progress++
		if err := s.recordCacheCleanupCheckpoint(statusCtx, job, checkpoint, completed, key, progress, total); err != nil {
			return true, err
		}
	}
	return false, nil
}

func (s *Server) recordCacheCleanupCheckpoint(
	ctx context.Context,
	job workflowJobRecord,
	checkpoint *cacheOrphanCleanupCheckpoint,
	completed map[string]bool,
	key string,
	progress int,
	total int,
) error {
	checkpoint.CompletedKeys = append(checkpoint.CompletedKeys, key)
	completed[key] = true
	if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "cleanup", *checkpoint, progress, total); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	return nil
}

func (s *Server) finishCacheOrphanCleanup(ctx context.Context, job workflowJobRecord, checkpoint cacheOrphanCleanupCheckpoint, finishCancelled func() error) error {
	output := mustJSON(map[string]any{"deleted_files": checkpoint.DeletedFiles, "freed_bytes": checkpoint.FreedBytes})
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var runStatus string
	if err := tx.QueryRowContext(ctx, "SELECT status FROM workflow_run WHERE id = ?", job.RunID).Scan(&runStatus); err != nil {
		return err
	}
	if runStatus == "cancelled" {
		_ = tx.Rollback()
		return finishCancelled()
	}
	updated, err := updateCacheCleanupStep(ctx, tx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", output, job.NodeRunID)
	if err != nil {
		return err
	}
	if !updated {
		_ = tx.Rollback()
		return finishCancelled()
	}
	updated, err = updateCacheCleanupStep(ctx, tx, "UPDATE workflow_job SET status = 'succeeded', progress_current = progress_total, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'", job.ID)
	if err != nil {
		return err
	}
	if !updated {
		_ = tx.Rollback()
		return finishCancelled()
	}
	updated, err = updateCacheCleanupStep(ctx, tx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", output, job.RunID)
	if err != nil {
		return err
	}
	if !updated {
		_ = tx.Rollback()
		return finishCancelled()
	}
	return tx.Commit()
}

func updateCacheCleanupStep(ctx context.Context, tx *sql.Tx, query string, args ...any) (bool, error) {
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
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
	targetPath, err := validateDestructivePath(s.cfg.CacheRoot, relPath, true, false)
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
	if time.Since(info.ModTime()) < cacheOrphanGracePeriod {
		return false, 0, nil
	}
	deleted, bytes, err := removeDestructiveFile(s.cfg.CacheRoot, relPath)
	if err != nil {
		return false, 0, err
	}
	if !deleted {
		return false, 0, nil
	}
	if err := pruneEmptyCacheParents(s.cfg.CacheRoot, filepath.Dir(targetPath)); err != nil {
		return false, 0, err
	}
	return true, bytes, nil
}

func (s *Server) removeEmptyManagedCacheDirectory(relPath string) error {
	relPath = filepath.ToSlash(strings.TrimSpace(relPath))
	if !strings.HasPrefix(relPath, "media/") {
		return fmt.Errorf("cache maintenance directory is outside managed media cache")
	}
	target, err := validateDestructivePath(s.cfg.CacheRoot, relPath, true, true)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(target); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := validateDestructivePath(s.cfg.CacheRoot, relPath, false, true); err != nil {
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
	absCacheRoot, err := filepath.Abs(cacheRoot)
	if err != nil {
		return err
	}
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
		relative, err := filepath.Rel(absCacheRoot, current)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if _, err := validateDestructivePath(cacheRoot, relative, true, true); err != nil {
			return err
		}
		if _, err := os.Lstat(current); errors.Is(err, os.ErrNotExist) {
			current = filepath.Dir(current)
			continue
		} else if err != nil {
			return err
		}
		if _, err := validateDestructivePath(cacheRoot, relative, false, true); err != nil {
			return err
		}
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
