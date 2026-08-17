package httpapi

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const demoLibraryScanWorkflowCode = "demo_library_scan"

type DemoLibraryScanResult struct {
	RunID            int64    `json:"runId"`
	Status           string   `json:"status"`
	CandidateFolders int      `json:"candidateFolders"`
	DetectedWorks    int      `json:"detectedWorks"`
	ScannedFiles     int      `json:"scannedFiles"`
	EligibleWorks    int      `json:"eligibleWorks"`
	DiscardedWorks   int      `json:"discardedWorks"`
	FailedWorks      int      `json:"failedWorks"`
	IndexedFiles     int      `json:"indexedFiles"`
	Failures         []string `json:"failures"`
}

// RunDemoLibraryScan runs the only startup workflow enabled in Demo mode. It
// verifies provider metadata before creating local work and media records.
func (s *Server) RunDemoLibraryScan(ctx context.Context) (DemoLibraryScanResult, error) {
	if !s.cfg.IsDemo() {
		return DemoLibraryScanResult{}, fmt.Errorf("%s is only available in demo mode", demoLibraryScanWorkflowCode)
	}

	scanDepth := s.configuredLocalScanDepth(ctx)
	folders, summary, err := localfs.Discover(s.cfg.DataRoot, localfs.Options{ScanDepth: scanDepth})
	if err != nil {
		return DemoLibraryScanResult{}, err
	}
	result := DemoLibraryScanResult{
		Status:           "succeeded",
		CandidateFolders: summary.CandidateFolders,
		DetectedWorks:    summary.DetectedWorks,
		ScannedFiles:     summary.ScannedFiles,
		Failures:         []string{},
	}

	fileSourceID, err := s.prepareDemoLibraryScan(ctx, scanDepth)
	if err != nil {
		return result, err
	}

	duplicateCodes := map[string]bool{}
	for _, group := range summary.DuplicateGroups {
		duplicateCodes[strings.ToUpper(strings.TrimSpace(group.Code))] = true
	}

	syncer := metasync.NewDLsiteSyncer(s.db, s.dlsiteClient).
		WithCacheRoot(s.cfg.CacheRoot).
		WithMetadataPriority(s.preferredMetadataLanguages(ctx)).
		WithLanguages(dlsiteLanguageFallbacksForLanguages(s.preferredMetadataLanguages(ctx))).
		WithRequestPacing(
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_rate_limit_backoff_seconds", 30)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_max_backoff_seconds", 300)),
		)

	for _, folder := range folders {
		outcome := s.processDemoLibraryFolder(ctx, syncer, fileSourceID, folder, duplicateCodes)
		if outcome.Discarded {
			result.DiscardedWorks++
		}
		if outcome.Failure != "" {
			result.FailedWorks++
			result.Failures = append(result.Failures, outcome.Failure)
		}
		if outcome.Eligible {
			result.EligibleWorks++
			result.IndexedFiles += outcome.IndexedFiles
		}
	}

	if result.EligibleWorks > 0 {
		if err := s.syncPartiesFromDLsiteSnapshots(ctx); err != nil {
			result.Failures = append(result.Failures, fmt.Sprintf("sync demo creator metadata: %s", err.Error()))
		}
	}
	finalizeDemoLibraryScanStatus(&result)

	runID, err := s.recordDemoLibraryScan(ctx, scanDepth, summary, result)
	if err != nil {
		return result, err
	}
	result.RunID = runID
	return result, nil
}

type demoLibraryFolderOutcome struct {
	Eligible     bool
	Discarded    bool
	IndexedFiles int
	Failure      string
}

func (s *Server) processDemoLibraryFolder(ctx context.Context, syncer *metasync.DLsiteSyncer, fileSourceID int64, folder localfs.WorkFolder, duplicateCodes map[string]bool) demoLibraryFolderOutcome {
	code := strings.ToUpper(strings.TrimSpace(folder.Code))
	if duplicateCodes[code] {
		return demoLibraryFolderOutcome{Discarded: true}
	}
	product, err := syncer.FetchProduct(ctx, code)
	if err != nil {
		return demoLibraryFolderOutcome{Failure: fmt.Sprintf("%s: %s", code, err.Error())}
	}
	if fetchedCode := demoProductCode(product); !strings.EqualFold(fetchedCode, code) {
		return demoLibraryFolderOutcome{Failure: fmt.Sprintf("%s: provider returned mismatched code %q", code, fetchedCode)}
	}
	permanentlyFree := product.IsPermanentlyFree()
	if !contentpolicy.IsAllAges(product.AgeCategoryString) || permanentlyFree == nil || !*permanentlyFree {
		return demoLibraryFolderOutcome{Discarded: true}
	}
	workID, err := syncer.SyncProductForDemo(ctx, product)
	if err == nil {
		err = s.storeDemoLocalWork(ctx, fileSourceID, workID, folder)
	}
	if err == nil {
		err = s.syncVoiceCreditsForWorkFromSnapshots(ctx, workID)
	}
	if err != nil {
		_ = s.hideDemoWork(ctx, workID)
		return demoLibraryFolderOutcome{Failure: fmt.Sprintf("%s: %s", code, err.Error())}
	}
	return demoLibraryFolderOutcome{Eligible: true, IndexedFiles: len(folder.Files)}
}

func finalizeDemoLibraryScanStatus(result *DemoLibraryScanResult) {
	if len(result.Failures) == 0 {
		return
	}
	result.Status = "partial"
	if result.EligibleWorks == 0 && result.DiscardedWorks == 0 {
		result.Status = "failed"
	}
}

func (s *Server) prepareDemoLibraryScan(ctx context.Context, scanDepth int) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	// A stale successful classification must never survive a failed refresh.
	if _, err := tx.ExecContext(ctx, "UPDATE work SET age_rating = '', is_permanently_free = NULL"); err != nil {
		return 0, err
	}
	fileSourceID, err := s.upsertLocalFileSource(ctx, tx, scanDepth)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET availability = 'missing',
			last_checked_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ? AND presence_type = 'local'
	`, fileSourceID); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return fileSourceID, nil
}

func (s *Server) storeDemoLocalWork(ctx context.Context, fileSourceID int64, workID int64, folder localfs.WorkFolder) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: fileSourceID,
		PresenceType: "local",
		SourceURL:    filepath.ToSlash(folder.RelPath),
		Availability: "available",
		RawJSON: mustJSON(map[string]any{
			"code":              folder.Code,
			"title":             folder.Title,
			"rel_path":          filepath.ToSlash(folder.RelPath),
			"files":             len(folder.Files),
			"file_tree_scanned": true,
		}),
	}); err != nil {
		return err
	}
	seenPaths := make(map[string]bool, len(folder.Files))
	playableTrackNo := 1
	for _, file := range folder.Files {
		seenPaths[file.RelPath] = true
		kind := localFileKind(file.WorkRelPath)
		trackNo := 0
		if kind == "audio" || kind == "video" {
			trackNo = playableTrackNo
			playableTrackNo++
		}
		if kind == "audio" {
			hasAudio := true
			file.HasAudio = &hasAudio
		}
		mediaItemID, err := upsertDetectedMediaItem(ctx, tx, workID, folder, file, kind, trackNo)
		if err != nil {
			return err
		}
		if _, err := upsertDetectedLocation(ctx, tx, mediaItemID, fileSourceID, file); err != nil {
			return err
		}
	}
	if _, err := markMissingLocalLocationsForWork(ctx, tx, workID, fileSourceID, seenPaths); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) hideDemoWork(ctx context.Context, workID int64) error {
	if workID <= 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, "UPDATE work SET age_rating = '', is_permanently_free = NULL WHERE id = ?", workID)
	return err
}

func (s *Server) recordDemoLibraryScan(ctx context.Context, scanDepth int, summary localfs.Summary, result DemoLibraryScanResult) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	definitionID, err := workflow.EnsureDefinition(ctx, tx, demoLibraryScanWorkflowCode, "Scan Demo library", "Discover local Demo files, verify public eligibility, and index accepted works.", map[string]any{
		"nodes": []map[string]string{
			{"id": "discover", "type": "discover_local_files"},
			{"id": "verify", "type": "sync_metadata"},
			{"id": "index", "type": "sync_file_locations"},
		},
	})
	if err != nil {
		return 0, err
	}
	input := map[string]any{"root": s.cfg.DataRoot, "scan_depth": scanDepth}
	output := map[string]any{
		"candidate_folders": summary.CandidateFolders,
		"detected_works":    result.DetectedWorks,
		"scanned_files":     result.ScannedFiles,
		"eligible_works":    result.EligibleWorks,
		"discarded_works":   result.DiscardedWorks,
		"failed_works":      result.FailedWorks,
		"indexed_files":     result.IndexedFiles,
		"failures":          result.Failures,
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, demoLibraryScanWorkflowCode, "Scan Demo library", result.Status, "startup", "demo_mode", input, output)
	if err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_local_files", DisplayName: "Discover Demo files", Position: 1, Status: "succeeded",
		Input: input,
		Output: map[string]any{
			"candidate_folders": summary.CandidateFolders,
			"detected_works":    result.DetectedWorks,
			"scanned_files":     result.ScannedFiles,
			"ambiguous_folders": summary.AmbiguousFolders,
			"duplicate_groups":  localDuplicateGroupSummaries(summary.DuplicateGroups),
		},
	}); err != nil {
		return 0, err
	}
	verifyNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "verify", NodeType: "sync_metadata", DisplayName: "Verify Demo eligibility", Position: 2, Status: result.Status,
		Input:  map[string]any{"detected_works": result.DetectedWorks, "policy": "all_ages_and_permanently_free"},
		Output: map[string]any{"eligible_works": result.EligibleWorks, "discarded_works": result.DiscardedWorks, "failed_works": result.FailedWorks, "failures": result.Failures},
		Error:  strings.Join(result.Failures, "\n"),
	})
	if err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "index", NodeType: "sync_file_locations", DisplayName: "Index accepted Demo files", Position: 3, Status: result.Status,
		Input:  map[string]any{"eligible_works": result.EligibleWorks},
		Output: map[string]any{"indexed_files": result.IndexedFiles},
		Error:  strings.Join(result.Failures, "\n"),
	}); err != nil {
		return 0, err
	}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: verifyNodeID, WorkerType: demoLibraryScanWorkflowCode, Status: result.Status,
		Payload: input, ProgressCurrent: result.EligibleWorks + result.DiscardedWorks + result.FailedWorks, ProgressTotal: result.DetectedWorks,
		Error: strings.Join(result.Failures, "\n"),
	}); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return runID, nil
}

func demoProductCode(product dlsite.Product) string {
	code := strings.ToUpper(strings.TrimSpace(product.WorkNo))
	if code == "" {
		code = strings.ToUpper(strings.TrimSpace(product.ProductID))
	}
	return code
}
