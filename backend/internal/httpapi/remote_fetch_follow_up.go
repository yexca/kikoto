package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// remoteFetchFollowUpRetryPeriod is how often a follow-up that waits for
// offline storage is tried again.
const remoteFetchFollowUpRetryPeriod = time.Minute

// remoteFetchFollowUp is what a Fetch into a new folder adds to that folder
// once it is published: files of the work's other local folders and remote
// editions. It runs as an Edit files run
// of the published folder, so each file is collected, checked, and published
// the way an edit of an existing folder does it.
type remoteFetchFollowUp struct {
	Additions []workFolderEditAdditionRequest `json:"additions"`
	Decisions []remoteFetchFileDecision       `json:"decisions"`
}

func (followUp *remoteFetchFollowUp) empty() bool {
	return followUp == nil || len(followUp.Additions) == 0
}

// remoteWorkSavePlanResponse is a Fetch preview with the preview of its
// follow-up edit.
type remoteWorkSavePlanResponse struct {
	remoteWorkSavePlan
	FollowUp *workFolderEditPlan `json:"followUp,omitempty"`
}

// remoteFetchFollowUpPermissions is what a Fetch with a follow-up needs on
// top of the Fetch itself: changing local files.
func remoteFetchFollowUpPermissions(followUp *remoteFetchFollowUp) []string {
	if followUp.empty() {
		return nil
	}
	return []string{"downloads:manage"}
}

// planRemoteFetchFollowUp previews the follow-up against the folder the Fetch
// publishes. The Fetch's own files are already taken there, so a follow-up
// file that would land on one is a conflict to resolve. It never changes a
// file.
func (s *Server) planRemoteFetchFollowUp(ctx context.Context, plan remoteWorkSavePlan, followUp *remoteFetchFollowUp) (workFolderEditPlan, error) {
	if len(followUp.Additions) > maxWorkFolderEditAdditions {
		return workFolderEditPlan{}, invalidRequestError(fmt.Sprintf("at most %d files can be added at once", maxWorkFolderEditAdditions))
	}
	code := firstNonBlankTrimmed(plan.EditionCode, plan.PrimaryCode)
	var workID int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workFolderEditPlan{}, conflictError("the work is not in the library yet; try again once its metadata has loaded")
		}
		return workFolderEditPlan{}, err
	}
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		return workFolderEditPlan{}, err
	}
	rootPath := normalizeFolderRootPath(plan.SaveRoot)
	rootAbsolute, err := safeDataPath(s.cfg.DataRoot, rootPath)
	if err != nil {
		return workFolderEditPlan{}, err
	}
	target := workFolderEditFolder{WorkID: workID, RootPath: rootPath, Absolute: rootAbsolute}
	candidates, err := s.workFolderEditCandidates(ctx, family, target, followUp.Additions)
	if err != nil {
		return workFolderEditPlan{}, err
	}
	seenTargets := map[string]string{}
	for _, item := range plan.Items {
		if item.Action != "exclude" {
			seenTargets[fetchTargetKey(item.TargetPath)] = item.Path
		}
	}
	decisions := normalizeRemoteFetchDecisions(followUp.Decisions)
	items := make([]workFolderEditItem, 0, len(candidates))
	for _, candidate := range candidates {
		if err := s.resolveWorkFolderEditItem(&candidate.remoteWorkSavePlanItem, decisions[candidate.ItemKey], rootPath, workFolderEditFiles{}, workFolderEditFiles{}, seenTargets); err != nil {
			return workFolderEditPlan{}, err
		}
		items = append(items, candidate)
	}
	if workFolderEditAddsToLyricsRoot(items, rootPath) {
		if _, err := os.Lstat(rootAbsolute); err == nil {
			if err := checkLyricsRootWritable(rootAbsolute); err != nil {
				return workFolderEditPlan{}, err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return workFolderEditPlan{}, err
		}
	}
	base := make([]remoteWorkSavePlanItem, len(items))
	for index := range items {
		base[index] = items[index].remoteWorkSavePlanItem
	}
	validateResolvedFetchTargets(base)
	if err := validateRemoteFetchDownloadPlan(base, s.remoteMediaDownloadLimitBytes(ctx)); err != nil {
		return workFolderEditPlan{}, rejectedRequestError("download_limit_exceeded", "a selected file is larger than the remote download limit", err)
	}
	for index := range items {
		items[index].remoteWorkSavePlanItem = base[index]
		// A review of the follow-up does not need the download addresses.
		items[index].SourcePath = ""
	}
	removals := []workFolderEditRemoval{}
	return workFolderEditPlan{
		WorkID: workID, PrimaryCode: strings.ToUpper(strings.TrimSpace(code)), SaveRoot: rootPath,
		Items: items, Removals: removals, Moves: []workFolderEditMove{}, Folders: []string{}, Merges: []workFolderEditMerge{},
		Summary: summarizeWorkFolderEdit(items, removals),
	}, nil
}

// prepareRemoteFetchFollowUp checks a follow-up before its Fetch is queued.
func (s *Server) prepareRemoteFetchFollowUp(ctx context.Context, plan remoteWorkSavePlan, followUp *remoteFetchFollowUp) (*remoteFetchFollowUp, error) {
	if followUp.empty() {
		return nil, nil
	}
	preview, err := s.planRemoteFetchFollowUp(ctx, plan, followUp)
	if err != nil {
		return nil, err
	}
	if preview.Summary.Conflict > 0 {
		return nil, workFolderEditConflictError{Summary: preview.Summary}
	}
	return &remoteFetchFollowUp{Additions: followUp.Additions, Decisions: followUp.Decisions}, nil
}

func remoteFetchFollowUpRequestID(runID int64) string {
	return fmt.Sprintf("fetch-follow-up:%d", runID)
}

// startRemoteFetchFollowUp queues the follow-up edit of a completed Fetch on
// the folder it published. A repeated call finds the run the first one queued.
// The outcome is recorded on the Fetch run and shown in its events: the edit
// run, a reason it can never be queued, or the offline storage it waits for. A
// follow-up that can no longer be applied leaves the published folder as the
// Fetch made it. One without a recorded outcome is queued again at startup,
// and one that waits for storage is retried until the storage is back; see
// recoverRemoteFetchFollowUps and retryRemoteFetchFollowUps.
func (s *Server) startRemoteFetchFollowUp(ctx context.Context, manifest remoteFetchManifestRecord) {
	// Startup recovery, the periodic retry, and a completing Fetch must not
	// both pass the request id check before either queues the run.
	s.fetchFollowUpMu.Lock()
	defer s.fetchFollowUpMu.Unlock()
	runID := manifest.WorkflowRunID
	var inputJSON string
	if err := s.db.QueryRowContext(ctx, "SELECT input_json FROM workflow_run WHERE id = ?", runID).Scan(&inputJSON); err != nil {
		slog.Warn("read Fetch follow-up", "run_id", runID, "error", err)
		return
	}
	var payload remoteWorkFetchJobPayload
	if err := json.Unmarshal([]byte(inputJSON), &payload); err != nil || payload.FollowUp.empty() {
		return
	}
	result, err := s.enqueueRemoteFetchFollowUp(ctx, manifest, payload)
	var recordErr error
	var storageErr libraryStorageError
	switch {
	case err == nil:
		recordErr = s.recordRemoteFetchFollowUp(ctx, runID, "$.follow_up_run_id", result.RunID, func(earlier remoteFetchFollowUpRecord) []workflow.EventSpec {
			events := []workflow.EventSpec{}
			if earlier.waiting {
				events = append(events, workflow.EventSpec{Level: "info", Type: "fetch.follow_up_queued",
					Message: fmt.Sprintf("The storage is back; workflow run #%d adds the files chosen from other places", result.RunID)})
			}
			if notice := legacyFollowUpLyricsNotice(inputJSON); notice != "" && !earlier.queued {
				events = append(events, workflow.EventSpec{Level: "warn", Type: "fetch.follow_up_lyrics_not_kept", Message: notice})
			}
			return events
		})
	case errors.As(err, &storageErr) && remoteFetchFollowUpWaitsFor(storageErr):
		slog.Info("Fetch follow-up waits for storage", "run_id", runID, "error", err)
		recordErr = s.recordRemoteFetchFollowUp(ctx, runID, "$.follow_up_waiting", storageErr.Message, func(earlier remoteFetchFollowUpRecord) []workflow.EventSpec {
			if earlier.waiting {
				return nil
			}
			return []workflow.EventSpec{{Level: "warn", Type: "fetch.follow_up_waiting",
				Message: "The files chosen from other places are added once the storage is back: " + storageErr.Message}}
		})
	default:
		slog.Warn("queue Fetch follow-up", "run_id", runID, "error", err)
		reason := publicRemoteFetchFollowUpError(err)
		recordErr = s.recordRemoteFetchFollowUp(ctx, runID, "$.follow_up_error", reason, func(remoteFetchFollowUpRecord) []workflow.EventSpec {
			return []workflow.EventSpec{{Level: "error", Type: "fetch.follow_up_failed",
				Message: "The files chosen from other places were not added to the fetched folder: " + reason}}
		})
	}
	if recordErr != nil {
		slog.Warn("record Fetch follow-up", "run_id", runID, "error", recordErr)
	}
}

// remoteFetchFollowUpWaitsFor reports whether a follow-up refused with err can
// still be queued later: the library or a storage pool it reads or writes is
// offline, not gone.
func remoteFetchFollowUpWaitsFor(err libraryStorageError) bool {
	return err.Code == errStoragePoolOffline.Code || err.Code == errLibraryOffline.Code
}

// legacyFollowUpLyricsNotice describes what a follow-up recorded while
// follow-ups still took lyrics languages and track bindings asked for that
// its edit no longer does: an addition with a language is added at its own
// path, and a binding is not stored, since lyrics of a language come in only
// through Lyrics files. It is "" for any other follow-up.
func legacyFollowUpLyricsNotice(inputJSON string) string {
	var input struct {
		FollowUp *struct {
			Additions []struct {
				Language *string `json:"language"`
			} `json:"additions"`
			Assignments []json.RawMessage `json:"assignments"`
		} `json:"follow_up"`
	}
	if err := json.Unmarshal([]byte(inputJSON), &input); err != nil || input.FollowUp == nil {
		return ""
	}
	languages := 0
	for _, addition := range input.FollowUp.Additions {
		if addition.Language != nil {
			languages++
		}
	}
	bindings := len(input.FollowUp.Assignments)
	switch {
	case languages > 0 && bindings > 0:
		return fmt.Sprintf("%d lyrics files chosen before the update are added at their own paths, and their %d track bindings were not stored; add lyrics of a language in Lyrics files", languages, bindings)
	case languages > 0:
		return fmt.Sprintf("%d lyrics files chosen before the update are added at their own paths; add lyrics of a language in Lyrics files", languages)
	case bindings > 0:
		return fmt.Sprintf("%d track bindings of lyrics chosen before the update were not stored; bind lyrics to tracks in Lyrics files", bindings)
	}
	return ""
}

// remoteFetchFollowUpRecord is what a Fetch run had recorded of its follow-up:
// waiting while it waits for storage, and queued once its edit run is
// recorded.
type remoteFetchFollowUpRecord struct {
	waiting, queued bool
}

// recordRemoteFetchFollowUp stores the follow-up's state at field of the Fetch
// run's summary, which replaces a wait for storage. events receives what the
// run had recorded before and returns the events Activity shows for the
// change.
func (s *Server) recordRemoteFetchFollowUp(ctx context.Context, runID int64, field string, value any, events func(earlier remoteFetchFollowUpRecord) []workflow.EventSpec) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var earlier remoteFetchFollowUpRecord
	if err := tx.QueryRowContext(ctx, `
		SELECT json_type(COALESCE(NULLIF(summary_json, ''), '{}'), '$.follow_up_waiting') IS NOT NULL,
			json_type(COALESCE(NULLIF(summary_json, ''), '{}'), '$.follow_up_run_id') IS NOT NULL
		FROM workflow_run WHERE id = ?
	`, runID).Scan(&earlier.waiting, &earlier.queued); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET summary_json = json_set(json_remove(COALESCE(NULLIF(summary_json, ''), '{}'), '$.follow_up_waiting'), ?, ?)
		WHERE id = ?
	`, field, value, runID); err != nil {
		return err
	}
	for _, spec := range events(earlier) {
		if err := workflow.InsertEvent(ctx, tx, runID, spec); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// publicRemoteFetchFollowUpError is the reason Activity shows for a follow-up
// that was not queued. Only messages written for the user pass through; any
// other cause can carry a local path and stays in the server log.
func publicRemoteFetchFollowUpError(err error) string {
	var requestErr *requestError
	var conflict workFolderEditConflictError
	var lyricsErr lyricsFetchRequestError
	var storageErr libraryStorageError
	switch {
	case errors.As(err, &requestErr):
		return requestErr.message
	case errors.As(err, &conflict):
		return conflict.Error()
	case errors.As(err, &lyricsErr) && lyricsErr.message != "":
		return lyricsErr.message
	case errors.As(err, &storageErr):
		return storageErr.Message
	case errors.Is(err, sql.ErrNoRows):
		return "the fetched folder is no longer in the library"
	default:
		return "the follow-up edit could not be queued; see the server log for details"
	}
}

// recoverRemoteFetchFollowUps queues, at startup, the follow-up of every
// completed Fetch without a recorded run or failure: one the service stopped
// before queueing, and one waiting for storage. The follow-up's request id
// makes a run that was queued but not yet recorded count as queued. It never
// keeps the service from starting: a failure is logged, and the next start
// tries again.
func (s *Server) recoverRemoteFetchFollowUps(ctx context.Context) {
	s.queuePendingRemoteFetchFollowUps(ctx, false)
}

// retryRemoteFetchFollowUps queues each follow-up that waits for storage once
// the storage is back.
func (s *Server) retryRemoteFetchFollowUps(ctx context.Context) {
	s.queuePendingRemoteFetchFollowUps(ctx, true)
}

func (s *Server) queuePendingRemoteFetchFollowUps(ctx context.Context, waitingOnly bool) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT run.id
		FROM workflow_run AS run
		INNER JOIN remote_fetch_manifest AS manifest
			ON manifest.workflow_run_id = run.id AND manifest.state = 'completed'
		WHERE run.workflow_code = 'remote_work_fetch'
			AND run.status = 'succeeded'
			AND json_array_length(COALESCE(NULLIF(run.input_json, ''), '{}'), '$.follow_up.additions') > 0
			AND json_type(COALESCE(NULLIF(run.summary_json, ''), '{}'), '$.follow_up_run_id') IS NULL
			AND json_type(COALESCE(NULLIF(run.summary_json, ''), '{}'), '$.follow_up_error') IS NULL
			AND (NOT ? OR json_type(COALESCE(NULLIF(run.summary_json, ''), '{}'), '$.follow_up_waiting') IS NOT NULL)
		ORDER BY run.id ASC
	`, waitingOnly)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			slog.Error("find pending Fetch follow-ups", "error", err)
		}
		return
	}
	runIDs := []int64{}
	for rows.Next() {
		var runID int64
		if err := rows.Scan(&runID); err != nil {
			slog.Error("find pending Fetch follow-ups", "error", err)
			_ = rows.Close()
			return
		}
		runIDs = append(runIDs, runID)
	}
	if err := rows.Close(); err != nil {
		slog.Error("find pending Fetch follow-ups", "error", err)
		return
	}
	for _, runID := range runIDs {
		if ctx.Err() != nil {
			return
		}
		manifest, err := s.loadRemoteFetchManifest(ctx, runID)
		if err != nil {
			slog.Error("load pending Fetch follow-up", "run_id", runID, "error", err)
			continue
		}
		s.startRemoteFetchFollowUp(ctx, manifest)
	}
}

func (s *Server) enqueueRemoteFetchFollowUp(ctx context.Context, manifest remoteFetchManifestRecord, payload remoteWorkFetchJobPayload) (workFolderEditResult, error) {
	var folderID int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id FROM work_folder_location
		WHERE work_id = ? AND file_source_id = ? AND root_path = ? AND state = 'active'
	`, manifest.WorkID, manifest.LocalSourceID, manifest.TargetRoot).Scan(&folderID)
	if err != nil {
		return workFolderEditResult{}, err
	}
	return s.enqueueWorkFolderEdit(ctx, manifest.WorkID, workFolderEditRequest{
		FolderID: folderID, Additions: payload.FollowUp.Additions, Decisions: payload.FollowUp.Decisions,
		RequestID: remoteFetchFollowUpRequestID(manifest.WorkflowRunID),
	}, payload.RequestedByUserID)
}
