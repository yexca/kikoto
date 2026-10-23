package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	rankingWorkflowCode  = "ranking_refresh"
	rankingDisplayName   = "Refresh rankings"
	rankingWorkerType    = "ranking_refresh"
	rankingDescription   = "Pull the tracked DLsite and remote source rankings and record how they changed. Works are not added to the library."
	rankingMaxTitleRunes = 300
	rankingMaxMakerRunes = 200
)

var (
	errRankingRunActive     = errors.New("a ranking refresh is already active")
	errRankingNothingToPull = errors.New("no enabled ranking to refresh")
)

type rankingJobPayload struct {
	RequestedByUserID int64   `json:"requestedByUserId,omitempty"`
	ListIDs           []int64 `json:"listIds,omitempty"`
}

type rankingListOutcome struct {
	ListID             int64  `json:"listId"`
	Status             string `json:"status"`
	Items              int    `json:"items"`
	Changed            bool   `json:"changed"`
	New                int    `json:"new"`
	Reentered          int    `json:"reentered"`
	Dropped            int    `json:"dropped"`
	SkippedWithoutCode int    `json:"skippedWithoutCode"`
}

type rankingRunResult struct {
	RunID    int64                `json:"runId"`
	JobID    int64                `json:"jobId"`
	Status   string               `json:"status"`
	Lists    []rankingListOutcome `json:"lists"`
	Failures []string             `json:"failures"`
}

func rankingNodes() []map[string]string {
	return []map[string]string{
		{"id": "pull", "type": "pull_rankings", "displayName": "Pull rankings"},
		{"id": "record", "type": "record_rankings", "displayName": "Record changes"},
	}
}

// enqueueRankingRefresh queues one refresh of listIDs, or of every enabled
// list when listIDs is empty. One refresh is queued or running at a time; a
// request while one is active returns it with errRankingRunActive.
func (s *Server) enqueueRankingRefresh(ctx context.Context, trigger workflowRunTrigger, requestedBy int64, listIDs []int64) (rankingRunResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return rankingRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var activeID int64
	var activeStatus string
	err = tx.QueryRowContext(ctx, `
		SELECT id, status FROM workflow_run WHERE workflow_code = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1
	`, rankingWorkflowCode).Scan(&activeID, &activeStatus)
	if err == nil {
		return rankingRunResult{RunID: activeID, Status: activeStatus, Lists: []rankingListOutcome{}, Failures: []string{}}, errRankingRunActive
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return rankingRunResult{}, err
	}
	var enabled int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM ranking_list WHERE enabled = 1").Scan(&enabled); err != nil {
		return rankingRunResult{}, err
	}
	if enabled == 0 {
		return rankingRunResult{}, errRankingNothingToPull
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, rankingWorkflowCode, rankingDisplayName, rankingDescription, map[string]any{"nodes": rankingNodes()})
	if err != nil {
		return rankingRunResult{}, err
	}
	result := rankingRunResult{Status: "queued", Lists: []rankingListOutcome{}, Failures: []string{}}
	input := map[string]any{}
	if len(listIDs) > 0 {
		input["list_ids"] = listIDs
	}
	if requestedBy > 0 {
		input[workflowRunRequesterKey] = requestedBy
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, rankingWorkflowCode, rankingDisplayName, "queued", trigger.Type, trigger.Reason, input, result)
	if err != nil {
		return rankingRunResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return rankingRunResult{}, err
		}
	}
	var pullNodeID int64
	for index, node := range rankingNodes() {
		id, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
			NodeID: node["id"], NodeType: node["type"], DisplayName: node["displayName"], Position: index + 1, Status: "queued",
		})
		if err != nil {
			return rankingRunResult{}, err
		}
		if index == 0 {
			pullNodeID = id
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: pullNodeID, WorkerType: rankingWorkerType, Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "metadata:provider",
		Payload:    rankingJobPayload{RequestedByUserID: requestedBy, ListIDs: listIDs},
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: false, MaxRetries: 1,
	})
	if err != nil {
		return rankingRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return rankingRunResult{}, err
	}
	result.RunID, result.JobID = runID, jobID
	return result, nil
}

func (s *Server) executeRankingSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	_, err := s.enqueueRankingRefresh(ctx, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID}, 0, nil)
	if errors.Is(err, errRankingRunActive) {
		return "succeeded", nil, nil
	}
	if errors.Is(err, errRankingNothingToPull) {
		// Without an enabled list there is nothing to record and no run.
		_, err = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_success_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", trigger.ID)
		return "succeeded", nil, err
	}
	return "succeeded", nil, err
}

// rankingPulledItem is one ranked work as its list returned it.
type rankingPulledItem struct {
	Code         string
	Title        string
	Maker        string
	RemoteWorkID int64
	CoverURL     string
}

type rankingPull struct {
	Items              []rankingPulledItem
	SkippedWithoutCode int
}

// errRankingSourceUnavailable marks a remote list whose source is disabled,
// removed, or no longer compatible; its last snapshot stays readable.
var errRankingSourceUnavailable = errors.New("remote source is unavailable")

type rankingPuller interface {
	pull(ctx context.Context, list rankingList) (rankingPull, error)
}

type serverRankingPuller struct {
	server *Server
	dlsite dlsiteRankingProvider
}

func (puller serverRankingPuller) pull(ctx context.Context, list rankingList) (rankingPull, error) {
	if list.Provider == rankingProviderDLsite {
		ranking, err := puller.dlsite.FetchVoiceRanking(ctx, dlsite.RankingOptions{Period: list.Period, ReleaseWindow: list.ReleaseWindow})
		if err != nil {
			return rankingPull{}, err
		}
		items := ranking.Items
		if len(items) == 0 {
			for _, code := range ranking.WorkCodes {
				items = append(items, dlsite.RankingItem{Code: code})
			}
		}
		pull := rankingPull{Items: make([]rankingPulledItem, 0, min(len(items), list.Depth))}
		for _, item := range items {
			if len(pull.Items) >= list.Depth {
				break
			}
			pull.Items = append(pull.Items, rankingPulledItem{Code: item.Code, Title: item.Title, Maker: item.Maker})
		}
		return pull, nil
	}
	if list.SourceID == nil {
		return rankingPull{}, errRankingSourceUnavailable
	}
	source, err := puller.server.loadRemoteSourceForUse(ctx, *list.SourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return rankingPull{}, errRankingSourceUnavailable
		}
		return rankingPull{}, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled || strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return rankingPull{}, errRankingSourceUnavailable
	}
	page, err := puller.server.kikoeruCrawlClientForSource(ctx, source).PopularWorks(ctx, 1, list.Depth)
	if err != nil {
		_ = puller.server.updateSourceHealth(ctx, source.ID, "unavailable")
		return rankingPull{}, err
	}
	_ = puller.server.updateSourceHealth(ctx, source.ID, "healthy")
	works := uniqueRemoteCollectionWorks(page.Works, list.Depth)
	pull := rankingPull{Items: make([]rankingPulledItem, 0, len(works))}
	for _, work := range page.Works {
		if normalizedRemoteWorkCode(work) == "" {
			pull.SkippedWithoutCode++
		}
	}
	for _, work := range works {
		item := rankingPulledItem{
			Code:         strings.ToUpper(normalizedRemoteWorkCode(work)),
			Title:        work.Title,
			RemoteWorkID: work.ID,
			CoverURL:     strings.TrimSpace(work.ThumbnailCoverURL),
		}
		if item.CoverURL == "" {
			item.CoverURL = strings.TrimSpace(work.MainCoverURL)
		}
		if work.Circle != nil {
			item.Maker = work.Circle.Name
		}
		pull.Items = append(pull.Items, item)
	}
	return pull, nil
}

func (s *Server) executeRankingRefreshJob(ctx context.Context, job workflowJobRecord) error {
	return s.executeRankingRefreshJobWith(ctx, job, serverRankingPuller{server: s, dlsite: s.newDLsiteClient()})
}

func (s *Server) executeRankingRefreshJobWith(ctx context.Context, job workflowJobRecord, puller rankingPuller) error {
	var payload rankingJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Ranking refresh input is invalid")
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	where, args := "list.enabled = 1", []any{}
	if len(payload.ListIDs) > 0 {
		where = "list.enabled = 1 AND list.id IN (" + sqlPlaceholders(len(payload.ListIDs)) + ")"
		for _, id := range payload.ListIDs {
			args = append(args, id)
		}
	}
	lists, err := s.loadRankingLists(ctx, 0, where, args...)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Rankings could not be loaded")
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", job.RunID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", nodeIDs["pull"]); err != nil {
		return err
	}
	result := rankingRunResult{RunID: job.RunID, JobID: job.ID, Lists: []rankingListOutcome{}, Failures: []string{}}
	pulls := make([]rankingPull, len(lists))
	pulled := make([]bool, len(lists))
	pullFailures := []string{}
	for index, list := range lists {
		if err := ctx.Err(); err != nil {
			return err
		}
		pull, err := puller.pull(ctx, list)
		if err != nil {
			status := "failed"
			if errors.Is(err, errRankingSourceUnavailable) {
				status = "source_unavailable"
			}
			message := fmt.Sprintf("%s: %s", rankingListLabel(list), err.Error())
			pullFailures = append(pullFailures, message)
			result.Lists = append(result.Lists, rankingListOutcome{ListID: list.ID, Status: status})
			s.execBestEffort(ctx, "record ranking pull failure", "UPDATE ranking_list SET last_status = ?, last_error = ? WHERE id = ?", status, err.Error(), list.ID)
			_ = s.recordWorkflowRunEvent(ctx, job.RunID, "warning", "ranking_pull_failed", message, map[string]any{"list_id": list.ID})
			continue
		}
		pulls[index], pulled[index] = pull, true
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "pull", map[string]any{"pulled": index + 1}, index+1, len(lists))
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", nodeIDs["record"]); err != nil {
		return err
	}
	recordFailures := []string{}
	for index, list := range lists {
		if !pulled[index] {
			continue
		}
		outcome, err := s.recordRankingPull(ctx, list, job.RunID, pulls[index], time.Now().UTC())
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			message := fmt.Sprintf("%s: %s", rankingListLabel(list), err.Error())
			recordFailures = append(recordFailures, message)
			result.Lists = append(result.Lists, rankingListOutcome{ListID: list.ID, Status: "failed"})
			slog.Warn("ranking snapshot could not be recorded", "list_id", list.ID, "error", err)
			continue
		}
		result.Lists = append(result.Lists, outcome)
	}
	result.Failures = append(append(result.Failures, pullFailures...), recordFailures...)
	succeeded := len(lists) - len(result.Failures)
	switch {
	case len(result.Failures) == 0:
		result.Status = "succeeded"
	case succeeded > 0:
		result.Status = "partial"
	default:
		result.Status = "failed"
	}
	return s.finishRankingRefreshJob(ctx, job, nodeIDs, result, pullFailures, recordFailures)
}

// rankingListLabel names a list in run logs.
func rankingListLabel(list rankingList) string {
	if list.Provider == rankingProviderRemote {
		return "remote source " + firstNonEmpty(list.SourceName, "ranking")
	}
	label := "DLsite " + list.Period
	if list.ReleaseWindow != "" {
		label += " (" + list.ReleaseWindow + ")"
	}
	return label
}

func rankingContentHash(items []rankingPulledItem) string {
	codes := make([]string, 0, len(items))
	for _, item := range items {
		codes = append(codes, item.Code)
	}
	sum := sha256.Sum256([]byte(strings.Join(codes, "\n")))
	return hex.EncodeToString(sum[:])
}

func clampRankingText(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	if runes := []rune(value); len(runes) > limit {
		value = string(runes[:limit])
	}
	return value
}

// recordRankingPull stores one pull. An order equal to the latest snapshot
// only refreshes the display text and the pull time; any other order becomes
// a new snapshot and updates each entry's streak, best rank, and appearances.
func (s *Server) recordRankingPull(ctx context.Context, list rankingList, runID int64, pull rankingPull, now time.Time) (rankingListOutcome, error) {
	outcome := rankingListOutcome{ListID: list.ID, Status: "succeeded", Items: len(pull.Items), SkippedWithoutCode: pull.SkippedWithoutCode}
	pulledAt := formatWorkflowTimestamp(now)
	hash := rankingContentHash(pull.Items)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return outcome, err
	}
	defer func() { _ = tx.Rollback() }()
	var latestID int64
	var latestHash string
	err = tx.QueryRowContext(ctx, `
		SELECT id, content_hash FROM ranking_snapshot WHERE ranking_list_id = ? ORDER BY pulled_at DESC, id DESC LIMIT 1
	`, list.ID).Scan(&latestID, &latestHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return outcome, err
	}
	previous := map[string]bool{}
	if latestID > 0 {
		rows, err := tx.QueryContext(ctx, "SELECT primary_code FROM ranking_snapshot_item WHERE snapshot_id = ?", latestID)
		if err != nil {
			return outcome, err
		}
		for rows.Next() {
			var code string
			if err := rows.Scan(&code); err != nil {
				_ = rows.Close()
				return outcome, err
			}
			previous[code] = true
		}
		if err := rows.Close(); err != nil {
			return outcome, err
		}
	}
	outcome.Changed = latestID == 0 || latestHash != hash
	var snapshotID int64
	if outcome.Changed {
		var run any
		if runID > 0 {
			run = runID
		}
		inserted, err := tx.ExecContext(ctx, `
			INSERT INTO ranking_snapshot (ranking_list_id, pulled_at, workflow_run_id, item_count, content_hash) VALUES (?, ?, ?, ?, ?)
		`, list.ID, pulledAt, run, len(pull.Items), hash)
		if err != nil {
			return outcome, err
		}
		if snapshotID, err = inserted.LastInsertId(); err != nil {
			return outcome, err
		}
	}
	current := map[string]bool{}
	for index, item := range pull.Items {
		rank := index + 1
		current[item.Code] = true
		title := clampRankingText(item.Title, rankingMaxTitleRunes)
		maker := clampRankingText(item.Maker, rankingMaxMakerRunes)
		if !outcome.Changed {
			if _, err := tx.ExecContext(ctx, `
				UPDATE ranking_entry
				SET title = CASE WHEN ? <> '' THEN ? ELSE title END,
					maker_name = CASE WHEN ? <> '' THEN ? ELSE maker_name END,
					remote_work_id = CASE WHEN ? > 0 THEN ? ELSE remote_work_id END,
					remote_cover_url = CASE WHEN ? <> '' THEN ? ELSE remote_cover_url END
				WHERE ranking_list_id = ? AND primary_code = ?
			`, title, title, maker, maker, item.RemoteWorkID, item.RemoteWorkID, item.CoverURL, item.CoverURL, list.ID, item.Code); err != nil {
				return outcome, err
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO ranking_snapshot_item (snapshot_id, rank, primary_code) VALUES (?, ?, ?)", snapshotID, rank, item.Code); err != nil {
			return outcome, err
		}
		var known bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM ranking_entry WHERE ranking_list_id = ? AND primary_code = ?)", list.ID, item.Code).Scan(&known); err != nil {
			return outcome, err
		}
		if !known {
			outcome.New++
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO ranking_entry (ranking_list_id, primary_code, title, maker_name, remote_work_id, remote_cover_url,
					first_seen_at, streak_started_at, last_seen_at, best_rank, appearances)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
			`, list.ID, item.Code, title, maker, item.RemoteWorkID, item.CoverURL, pulledAt, pulledAt, pulledAt, rank); err != nil {
				return outcome, err
			}
			continue
		}
		continuing := previous[item.Code]
		if !continuing {
			outcome.Reentered++
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ranking_entry
			SET title = CASE WHEN ? <> '' THEN ? ELSE title END,
				maker_name = CASE WHEN ? <> '' THEN ? ELSE maker_name END,
				remote_work_id = CASE WHEN ? > 0 THEN ? ELSE remote_work_id END,
				remote_cover_url = CASE WHEN ? <> '' THEN ? ELSE remote_cover_url END,
				streak_started_at = CASE WHEN ? THEN streak_started_at ELSE ? END,
				last_seen_at = ?,
				best_rank = MIN(best_rank, ?),
				appearances = appearances + 1
			WHERE ranking_list_id = ? AND primary_code = ?
		`, title, title, maker, maker, item.RemoteWorkID, item.RemoteWorkID, item.CoverURL, item.CoverURL,
			continuing, pulledAt, pulledAt, rank, list.ID, item.Code); err != nil {
			return outcome, err
		}
	}
	if outcome.Changed {
		for code := range previous {
			if !current[code] {
				outcome.Dropped++
			}
		}
		// Entries that left the list longer ago than the retention go with
		// the snapshots that held them.
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM ranking_entry
			WHERE ranking_list_id = ? AND last_seen_at < datetime('now', '`+rankingRetention+`')
				AND primary_code NOT IN (SELECT primary_code FROM ranking_snapshot_item WHERE snapshot_id = ?)
		`, list.ID, snapshotID); err != nil {
			return outcome, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ranking_list SET last_pulled_at = ?, last_status = 'succeeded', last_error = '' WHERE id = ?
	`, pulledAt, list.ID); err != nil {
		return outcome, err
	}
	return outcome, tx.Commit()
}

func (s *Server) finishRankingRefreshJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, result rankingRunResult, pullFailures, recordFailures []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	pulled, changed := 0, 0
	for _, outcome := range result.Lists {
		if outcome.Status == "succeeded" {
			pulled++
		}
		if outcome.Changed {
			changed++
		}
	}
	nodeStatus := func(failures []string, succeeded int) string {
		switch {
		case len(failures) == 0:
			return "succeeded"
		case succeeded > 0:
			return "partial"
		default:
			return "failed"
		}
	}
	updates := []struct {
		node, status string
		output       map[string]any
		failures     []string
	}{
		{"pull", nodeStatus(pullFailures, pulled+len(recordFailures)), map[string]any{"lists": len(result.Lists), "failed": len(pullFailures)}, pullFailures},
		{"record", nodeStatus(recordFailures, pulled), map[string]any{"recorded": pulled, "changed": changed, "lists": result.Lists}, recordFailures},
	}
	for _, update := range updates {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP WHERE id = ?
		`, update.status, mustJSON(update.output), strings.Join(update.failures, "\n"), nodeIDs[update.node]); err != nil {
			return err
		}
	}
	errorMessage := strings.Join(result.Failures, "\n")
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, error_message = ?, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, errorMessage, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, result.Status, mustJSON(result), job.RunID); err != nil {
		return err
	}
	if result.Status == "succeeded" {
		if err := updateWorkflowTriggerSuccess(ctx, tx, job.RunID); err != nil {
			return err
		}
	} else if err := updateWorkflowTriggerFailure(ctx, tx, job.RunID, "Ranking refresh completed with some failures"); err != nil {
		return err
	}
	return tx.Commit()
}
