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
)

// remoteFetchFollowUp is what a Fetch into a new folder adds to that folder
// once it is published: files of the work's other local folders and remote
// editions, and lyrics of a declared language. It runs as an Edit files run
// of the published folder, so each file is collected, checked, and published
// the way an edit of an existing folder does it.
type remoteFetchFollowUp struct {
	Additions   []workFolderEditAdditionRequest `json:"additions"`
	Decisions   []remoteFetchFileDecision       `json:"decisions"`
	Assignments []workFolderEditAssignment      `json:"assignments,omitempty"`
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
// top of the Fetch itself: changing local files, and writing library lyrics
// when it assigns lyrics to tracks.
func remoteFetchFollowUpPermissions(followUp *remoteFetchFollowUp) []string {
	if followUp.empty() {
		return nil
	}
	permissions := []string{"downloads:manage"}
	if len(followUp.Assignments) > 0 {
		permissions = append(permissions, "library:write")
	}
	return permissions
}

// planRemoteFetchFollowUp previews the follow-up against the folder the Fetch
// publishes. The Fetch's own files are already taken there, so a follow-up
// file that would land on one is a conflict to resolve. It never changes a
// file.
func (s *Server) planRemoteFetchFollowUp(ctx context.Context, plan remoteWorkSavePlan, followUp *remoteFetchFollowUp) (workFolderEditPlan, error) {
	if len(followUp.Additions) > maxWorkFolderEditAdditions {
		return workFolderEditPlan{}, invalidRequestError(fmt.Sprintf("at most %d files can be added at once", maxWorkFolderEditAdditions))
	}
	code := firstNonEmpty(plan.EditionCode, plan.PrimaryCode)
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
	if workFolderEditAddsLyrics(candidates) {
		if _, err := os.Lstat(rootAbsolute); err == nil {
			if err := checkLyricsRootWritable(rootAbsolute); err != nil {
				return workFolderEditPlan{}, err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return workFolderEditPlan{}, err
		}
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
		decision, err := workFolderEditItemDecision(candidate, decisions[candidate.ItemKey], rootPath)
		if err != nil {
			return workFolderEditPlan{}, err
		}
		if err := s.resolveWorkFolderEditItem(&candidate.remoteWorkSavePlanItem, decision, rootPath, workFolderEditFiles{}, workFolderEditFiles{}, seenTargets); err != nil {
			return workFolderEditPlan{}, err
		}
		items = append(items, candidate)
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

// prepareRemoteFetchFollowUp checks a follow-up before its Fetch is queued and
// returns it with its assignments validated.
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
	assignments, err := s.workFolderEditAssignments(ctx, preview, followUp.Assignments)
	if err != nil {
		return nil, err
	}
	return &remoteFetchFollowUp{Additions: followUp.Additions, Decisions: followUp.Decisions, Assignments: assignments}, nil
}

func remoteFetchFollowUpRequestID(runID int64) string {
	return fmt.Sprintf("fetch-follow-up:%d", runID)
}

// startRemoteFetchFollowUp queues the follow-up edit of a completed Fetch on
// the folder it published. A repeated call finds the run the first one queued.
// The outcome is recorded on the Fetch run; a follow-up that can no longer be
// applied leaves the published folder as the Fetch made it.
func (s *Server) startRemoteFetchFollowUp(ctx context.Context, manifest remoteFetchManifestRecord) {
	var inputJSON string
	if err := s.db.QueryRowContext(ctx, "SELECT input_json FROM workflow_run WHERE id = ?", manifest.WorkflowRunID).Scan(&inputJSON); err != nil {
		slog.Warn("read Fetch follow-up", "run_id", manifest.WorkflowRunID, "error", err)
		return
	}
	var payload remoteWorkFetchJobPayload
	if err := json.Unmarshal([]byte(inputJSON), &payload); err != nil || payload.FollowUp.empty() {
		return
	}
	result, err := s.enqueueRemoteFetchFollowUp(ctx, manifest, payload)
	field, value := "$.follow_up_run_id", any(result.RunID)
	if err != nil {
		slog.Warn("queue Fetch follow-up", "run_id", manifest.WorkflowRunID, "error", err)
		field, value = "$.follow_up_error", err.Error()
	}
	s.execBestEffort(ctx, "record Fetch follow-up", `
		UPDATE workflow_run
		SET summary_json = json_set(COALESCE(NULLIF(summary_json, ''), '{}'), ?, ?)
		WHERE id = ?
	`, field, value, manifest.WorkflowRunID)
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
		Assignments: payload.FollowUp.Assignments, RequestID: remoteFetchFollowUpRequestID(manifest.WorkflowRunID),
	}, payload.RequestedByUserID)
}
