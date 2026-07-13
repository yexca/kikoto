package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

var errDLsitePopularAlreadyActive = errors.New("a matching DLsite popular collection is already queued or running")

type dlsitePopularRunRequest struct {
	Period        string `json:"period"`
	ReleaseWindow string `json:"releaseWindow"`
	Year          int    `json:"year"`
	TagName       string `json:"tagName"`
}

type dlsitePopularJobPayload struct {
	UserID        int64  `json:"user_id"`
	Period        string `json:"period"`
	ReleaseWindow string `json:"release_window"`
	Year          int    `json:"year"`
	TagName       string `json:"tag_name"`
}

type dlsitePopularRunResult struct {
	RunID         int64    `json:"runId"`
	Status        string   `json:"status"`
	Period        string   `json:"period"`
	ReleaseWindow string   `json:"releaseWindow"`
	Year          int      `json:"year"`
	TagName       string   `json:"tagName"`
	Discovered    int      `json:"discovered"`
	Synced        int      `json:"synced"`
	Tagged        int      `json:"tagged"`
	Failed        int      `json:"failed"`
	Failures      []string `json:"failures"`
}

type dlsitePopularCheckpoint struct {
	WorkCodes      []string               `json:"workCodes"`
	CompletedCodes []string               `json:"completedCodes"`
	Result         dlsitePopularRunResult `json:"result"`
}

type dlsiteRankingProvider interface {
	FetchVoiceRanking(context.Context, dlsite.RankingOptions) (dlsite.RankingResult, error)
}

type dlsiteFamilyMetadataSyncer interface {
	SyncFamily(context.Context, string) (metasync.DLsiteFamilySyncResult, error)
}

func (s *Server) createDLsitePopularCollectionRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "tags:write"); !ok {
		return
	}
	var payload dlsitePopularRunRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	normalized, err := normalizeDLsitePopularRequest(payload, time.Now())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.enqueueDLsitePopularCollection(r.Context(), actor.ID, normalized)
	if err != nil {
		if errors.Is(err, errDLsitePopularAlreadyActive) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func normalizeDLsitePopularRequest(payload dlsitePopularRunRequest, now time.Time) (dlsitePopularRunRequest, error) {
	payload.Period = strings.ToLower(strings.TrimSpace(payload.Period))
	switch payload.Period {
	case "day", "week", "month":
		payload.Year = 0
		payload.ReleaseWindow = strings.ToLower(strings.TrimSpace(payload.ReleaseWindow))
		if payload.ReleaseWindow != "" && payload.ReleaseWindow != "30d" {
			return dlsitePopularRunRequest{}, fmt.Errorf("releaseWindow must be empty or 30d")
		}
	case "year":
		payload.ReleaseWindow = ""
		if payload.Year < 2000 || payload.Year > now.UTC().Year() {
			return dlsitePopularRunRequest{}, fmt.Errorf("year must be between 2000 and %d", now.UTC().Year())
		}
	default:
		return dlsitePopularRunRequest{}, fmt.Errorf("period must be day, week, month, or year")
	}
	payload.TagName = strings.TrimSpace(payload.TagName)
	if payload.TagName == "" {
		payload.TagName = defaultDLsitePopularTag(payload, now)
	}
	runes := []rune(payload.TagName)
	if len(runes) > 40 {
		payload.TagName = string(runes[:40])
	}
	return payload, nil
}

func defaultDLsitePopularTag(payload dlsitePopularRunRequest, now time.Time) string {
	prefix := now.Format("060102") + "-DL-"
	if payload.Period == "year" {
		return fmt.Sprintf("%syear-%d-popular", prefix, payload.Year)
	}
	period := map[string]string{"day": "24h", "week": "7d", "month": "30d"}[payload.Period]
	window := "all"
	if payload.ReleaseWindow == "30d" {
		window = "r30d"
	}
	return fmt.Sprintf("%s%s-%s-popular", prefix, period, window)
}

func (s *Server) enqueueDLsitePopularCollection(ctx context.Context, userID int64, payload dlsitePopularRunRequest) (dlsitePopularRunResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return dlsitePopularRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var activeRunID int64
	err = tx.QueryRowContext(ctx, `
		SELECT run.id
		FROM workflow_run AS run
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE run.workflow_code = 'dlsite_popular_collection'
			AND run.status IN ('queued', 'running')
			AND CAST(json_extract(job.payload_json, '$.user_id') AS INTEGER) = ?
			AND json_extract(job.payload_json, '$.period') = ?
			AND COALESCE(json_extract(job.payload_json, '$.release_window'), '') = ?
			AND CAST(COALESCE(json_extract(job.payload_json, '$.year'), 0) AS INTEGER) = ?
		LIMIT 1
	`, userID, payload.Period, payload.ReleaseWindow, payload.Year).Scan(&activeRunID)
	if err == nil {
		return dlsitePopularRunResult{}, errDLsitePopularAlreadyActive
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return dlsitePopularRunResult{}, err
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "dlsite_popular_collection", "Collect DLsite popular voice works", "Discover a DLsite voice ranking, synchronize work metadata, and append a run tag for the current user.", dlsitePopularDefinition())
	if err != nil {
		return dlsitePopularRunResult{}, err
	}
	input := map[string]any{"period": payload.Period, "release_window": payload.ReleaseWindow, "year": payload.Year, "tag_name": payload.TagName, "user_id": userID}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "dlsite_popular_collection", "Collect DLsite popular voice works", "queued", "manual", payload.Period, input, map[string]any{"tag_name": payload.TagName})
	if err != nil {
		return dlsitePopularRunResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "configure", NodeType: "select_ranking", DisplayName: "Configure ranking", Position: 1, Status: "succeeded", Input: input, Output: input}); err != nil {
		return dlsitePopularRunResult{}, err
	}
	discoverNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "discover", NodeType: "discover_provider_ranking", DisplayName: "Discover ranking", Position: 2, Status: "queued", Input: input})
	if err != nil {
		return dlsitePopularRunResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Sync metadata", Position: 3, Status: "queued", Input: map[string]any{"provider": "dlsite"}}); err != nil {
		return dlsitePopularRunResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "tag", NodeType: "assign_user_tags", DisplayName: "Add user tag", Position: 4, Status: "queued", Input: map[string]any{"tag_name": payload.TagName, "user_id": userID}}); err != nil {
		return dlsitePopularRunResult{}, err
	}
	result := dlsitePopularRunResult{RunID: runID, Status: "queued", Period: payload.Period, ReleaseWindow: payload.ReleaseWindow, Year: payload.Year, TagName: payload.TagName, Failures: []string{}}
	jobPayload := dlsitePopularJobPayload{UserID: userID, Period: payload.Period, ReleaseWindow: payload.ReleaseWindow, Year: payload.Year, TagName: payload.TagName}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: discoverNodeID, WorkerType: "dlsite_popular_collection", Status: "queued", Payload: jobPayload, Checkpoint: dlsitePopularCheckpoint{WorkCodes: []string{}, CompletedCodes: []string{}, Result: result}, Recoverable: true, MaxRetries: 3}); err != nil {
		return dlsitePopularRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return dlsitePopularRunResult{}, err
	}
	return result, nil
}

func dlsitePopularDefinition() map[string]any {
	return map[string]any{"nodes": []map[string]string{
		{"id": "configure", "type": "select_ranking", "displayName": "Configure ranking"},
		{"id": "discover", "type": "discover_provider_ranking", "displayName": "Discover ranking"},
		{"id": "metadata", "type": "sync_metadata", "displayName": "Sync metadata"},
		{"id": "tag", "type": "assign_user_tags", "displayName": "Add user tag"},
	}}
}

func (s *Server) executeDLsitePopularCollectionJob(ctx context.Context, job workflowJobRecord) error {
	language := normalizeDLsiteLanguage(s.settingStringContext(ctx, "dlsite_metadata_language", "ja-jp"))
	client := dlsite.NewClient(nil)
	requestDelay := durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5))
	if requestDelay < 500*time.Millisecond {
		requestDelay = 500 * time.Millisecond
	}
	syncer := metasync.NewDLsiteSyncer(s.db, client).
		WithCacheRoot(s.cfg.CacheRoot).
		WithLanguages(dlsiteLanguageFallbacks(language)).
		WithRequestPacing(
			requestDelay,
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_rate_limit_backoff_seconds", 30)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_max_backoff_seconds", 300)),
		)
	return s.executeDLsitePopularCollectionJobWith(ctx, job, client, syncer)
}

func (s *Server) executeDLsitePopularCollectionJobWith(ctx context.Context, job workflowJobRecord, rankingClient dlsiteRankingProvider, syncer dlsiteFamilyMetadataSyncer) error {
	var payload dlsitePopularJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	checkpoint := dlsitePopularCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result := checkpoint.Result
	result.RunID = job.RunID
	result.Status = "running"
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if len(checkpoint.WorkCodes) == 0 {
		ranking, err := rankingClient.FetchVoiceRanking(ctx, dlsite.RankingOptions{Period: payload.Period, ReleaseWindow: payload.ReleaseWindow, Year: payload.Year})
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		checkpoint.WorkCodes = ranking.WorkCodes
		result.Discovered = len(ranking.WorkCodes)
		checkpoint.Result = result
		if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"work_codes": ranking.WorkCodes, "count": len(ranking.WorkCodes)}), nodeIDs["discover"]); err != nil {
			return err
		}
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "discovered", checkpoint, len(checkpoint.CompletedCodes), len(checkpoint.WorkCodes))
	} else {
		result.Discovered = len(checkpoint.WorkCodes)
		_, _ = s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"work_codes": checkpoint.WorkCodes, "count": len(checkpoint.WorkCodes), "resumed": true}), nodeIDs["discover"])
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", nodeIDs["metadata"]); err != nil {
		return err
	}
	completed := map[string]bool{}
	for _, code := range checkpoint.CompletedCodes {
		completed[strings.ToUpper(strings.TrimSpace(code))] = true
	}
	for index, rawCode := range checkpoint.WorkCodes {
		code := strings.ToUpper(strings.TrimSpace(rawCode))
		if code == "" || completed[code] {
			continue
		}
		if err := s.ensureWorkflowRunActive(ctx, job.RunID); err != nil {
			return err
		}
		family, syncErr := syncer.SyncFamily(ctx, code)
		if syncErr != nil {
			result.Failed++
			result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", code, syncErr.Error()))
		} else {
			var workID int64
			if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&workID); err != nil {
				result.Failed++
				result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", code, err.Error()))
			} else if _, err := s.addWorkUserTag(ctx, payload.UserID, []int64{workID}, payload.TagName); err != nil {
				result.Failed++
				result.Failures = append(result.Failures, fmt.Sprintf("%s tag: %s", code, err.Error()))
			} else {
				result.Synced++
				result.Tagged++
			}
			if len(family.Failures) > 0 {
				result.Failed++
				result.Failures = append(result.Failures, family.Failures...)
			}
		}
		completed[code] = true
		checkpoint.CompletedCodes = sortedStringKeys(completed)
		checkpoint.Result = result
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "syncing", checkpoint, index+1, len(checkpoint.WorkCodes))
	}
	result.Status = "succeeded"
	if result.Failed > 0 && result.Synced == 0 {
		result.Status = "failed"
	} else if result.Failed > 0 {
		result.Status = "partial"
	}
	return s.finishDLsitePopularCollection(ctx, job, nodeIDs, result)
}

func (s *Server) finishDLsitePopularCollection(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, result dlsitePopularRunResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	metadataStatus := result.Status
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", metadataStatus, mustJSON(map[string]any{"synced": result.Synced, "failed": result.Failed, "failures": result.Failures}), strings.Join(result.Failures, "\n"), nodeIDs["metadata"]); err != nil {
		return err
	}
	tagStatus := "succeeded"
	if result.Tagged < result.Discovered {
		tagStatus = "partial"
	}
	if result.Tagged == 0 && result.Discovered > 0 {
		tagStatus = "failed"
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", tagStatus, mustJSON(map[string]any{"tag_name": result.TagName, "tagged": result.Tagged}), nodeIDs["tag"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, result.Discovered, result.Discovered, strings.Join(result.Failures, "\n"), job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", result.Status, mustJSON(result), job.RunID); err != nil {
		return err
	}
	return tx.Commit()
}
