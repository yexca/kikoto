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
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	rankingPullWorkerType = "ranking_pull"
	rankingMaxTitleRunes  = 300
	rankingMaxMakerRunes  = 200
)

var (
	errRankingRunActive     = errors.New("a ranking pull is already active")
	errRankingNothingToPull = errors.New("no enabled ranking to refresh")
)

func rankingNodes() []map[string]string {
	return []map[string]string{
		{"id": "pull", "type": "pull_rankings", "displayName": "Pull rankings"},
		{"id": "record", "type": "record_rankings", "displayName": "Record changes"},
	}
}

// rankingWorkflowSpec is the definition of a workflow that pulls ranking
// lists. Neither adds works to the library, syncs metadata, tracks, fetches,
// or tags.
func rankingWorkflowSpec(code string) systemWorkflowSpec {
	if code == remoteRankingWorkflowCode {
		return systemWorkflowSpec{
			Code:        remoteRankingWorkflowCode,
			Name:        "Pull remote source rankings",
			Description: "Pull the due popular list of a compatible remote source and record how it changed. Works are not added to the library.",
			Nodes:       rankingNodes(),
		}
	}
	return systemWorkflowSpec{
		Code:        dlsiteRankingWorkflowCode,
		Name:        "Pull DLsite rankings",
		Description: "Pull the due DLsite voice rankings in each of their orders and record how they changed. Works are not added to the library.",
		Nodes:       rankingNodes(),
	}
}

type rankingJobPayload struct {
	RequestedByUserID int64  `json:"requestedByUserId,omitempty"`
	Provider          string `json:"provider"`
	SourceID          int64  `json:"sourceId,omitempty"`
}

// rankingListOutcome is what one pull of one variant recorded.
type rankingListOutcome struct {
	ListID             int64  `json:"listId"`
	VariantID          int64  `json:"variantId"`
	ReleaseWindow      string `json:"releaseWindow"`
	Sort               string `json:"sort"`
	Status             string `json:"status"`
	Items              int    `json:"items"`
	Changed            bool   `json:"changed"`
	New                int    `json:"new"`
	Reentered          int    `json:"reentered"`
	Dropped            int    `json:"dropped"`
	SkippedWithoutCode int    `json:"skippedWithoutCode"`
	// Final marks the last pull of an annual list after its year.
	Final bool `json:"final,omitempty"`
}

type rankingRunResult struct {
	RunID        int64                `json:"runId"`
	JobID        int64                `json:"jobId"`
	WorkflowCode string               `json:"workflowCode"`
	Status       string               `json:"status"`
	Lists        []rankingListOutcome `json:"lists"`
	Failures     []string             `json:"failures"`
}

// activeRankingRun returns the queued or running pull of a target, if any:
// one per workflow for DLsite and one per source for remote lists.
func (s *Server) activeRankingRun(ctx context.Context, q workflowTriggerQueryer, target rankingPullTarget) (rankingRunResult, error) {
	result := rankingRunResult{WorkflowCode: target.workflowCode(), Lists: []rankingListOutcome{}, Failures: []string{}}
	query := `SELECT id, status FROM workflow_run WHERE workflow_code = ? AND status IN ('queued', 'running')`
	args := []any{target.workflowCode()}
	if target.Provider == rankingProviderRemote {
		query += ` AND json_valid(input_json) AND CAST(json_extract(input_json, '$.source_id') AS INTEGER) = ?`
		args = append(args, target.SourceID)
	}
	err := q.QueryRowContext(ctx, query+` ORDER BY id DESC LIMIT 1`, args...).Scan(&result.RunID, &result.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return rankingRunResult{}, nil
	}
	return result, err
}

// enqueueRankingPull queues one pull run for a target. A run picks the due
// and requested lists when it starts. While one is queued or running, the
// request returns it with errRankingRunActive.
func (s *Server) enqueueRankingPull(ctx context.Context, target rankingPullTarget, trigger workflowRunTrigger, requestedBy int64) (rankingRunResult, error) {
	resourceKey := "metadata:provider"
	if target.Provider == rankingProviderRemote {
		source, err := s.loadRemoteSourceForUse(ctx, target.SourceID)
		if err != nil {
			return rankingRunResult{}, err
		}
		resourceKey = sourceResourceKey(source.Endpoint.APIURL)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return rankingRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	active, err := s.activeRankingRun(ctx, tx, target)
	if err != nil {
		return rankingRunResult{}, err
	}
	if active.RunID > 0 {
		return active, errRankingRunActive
	}
	spec := rankingWorkflowSpec(target.workflowCode())
	definitionID, err := workflow.EnsureDefinition(ctx, tx, spec.Code, spec.Name, spec.Description, map[string]any{"nodes": spec.Nodes})
	if err != nil {
		return rankingRunResult{}, err
	}
	result := rankingRunResult{WorkflowCode: spec.Code, Status: "queued", Lists: []rankingListOutcome{}, Failures: []string{}}
	input := map[string]any{"provider": target.Provider}
	if target.Provider == rankingProviderRemote {
		input["source_id"] = target.SourceID
	}
	if requestedBy > 0 {
		input[workflowRunRequesterKey] = requestedBy
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, spec.Code, spec.Name, "queued", trigger.Type, trigger.Reason, input, result)
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
		NodeRunID: pullNodeID, WorkerType: rankingPullWorkerType, Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: resourceKey,
		Payload:    rankingJobPayload{RequestedByUserID: requestedBy, Provider: target.Provider, SourceID: target.SourceID},
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

// requestRankingPulls asks for a pull of each named enabled list, or of every
// enabled list when listIDs is empty, and queues the run of each target. A
// target whose run is already active keeps the request for that run when it
// is still queued, and for the next run otherwise. Lists of a disabled or
// incompatible source wait until the source is available again.
func (s *Server) requestRankingPulls(ctx context.Context, listIDs []int64, requestedBy int64, reason string) ([]rankingRunResult, error) {
	where := `enabled = 1 AND (provider = 'dlsite' OR file_source_id IN (
		SELECT id FROM file_source WHERE enabled = 1 AND source_type IN ('` + sourceTypeKikoeruCompatible + `', '` + sourceTypeKikoeruCompatible178 + `')
	))`
	args := []any{}
	if len(listIDs) > 0 {
		where += " AND id IN (" + sqlPlaceholders(len(listIDs)) + ")"
		for _, id := range listIDs {
			args = append(args, id)
		}
	}
	now := formatWorkflowTimestamp(time.Now().UTC())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, "SELECT DISTINCT provider, COALESCE(file_source_id, 0) FROM ranking_list WHERE "+where+" ORDER BY provider, 2", args...)
	if err != nil {
		return nil, err
	}
	targets := []rankingPullTarget{}
	for rows.Next() {
		var target rankingPullTarget
		if err := rows.Scan(&target.Provider, &target.SourceID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		targets = append(targets, target)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		return nil, errRankingNothingToPull
	}
	if _, err := tx.ExecContext(ctx, "UPDATE ranking_list SET pull_requested_at = COALESCE(pull_requested_at, ?) WHERE "+where, append([]any{now}, args...)...); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	runs := make([]rankingRunResult, 0, len(targets))
	var firstErr error
	for _, target := range targets {
		run, err := s.enqueueRankingPull(ctx, target, workflowRunTrigger{Type: "manual", Reason: reason}, requestedBy)
		if err != nil && !errors.Is(err, errRankingRunActive) {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		runs = append(runs, run)
	}
	s.refreshRankingDispatchersBestEffort(ctx)
	if len(runs) == 0 {
		return nil, firstErr
	}
	return runs, nil
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

type dlsiteRankingProvider interface {
	FetchVoiceRanking(context.Context, dlsite.RankingOptions) (dlsite.RankingResult, error)
}

type rankingPuller interface {
	pull(ctx context.Context, list rankingList, variant rankingVariant) (rankingPull, error)
}

type serverRankingPuller struct {
	server *Server
	dlsite dlsiteRankingProvider
}

func (puller serverRankingPuller) pull(ctx context.Context, list rankingList, variant rankingVariant) (rankingPull, error) {
	if list.Provider == rankingProviderDLsite {
		ranking, err := puller.dlsite.FetchVoiceRanking(ctx, dlsite.RankingOptions{
			Period: list.Period, ReleaseWindow: variant.ReleaseWindow, Sort: variant.Sort, Year: list.Year,
		})
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
	works := uniqueRankingWorks(page.Works, list.Depth)
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

// uniqueRankingWorks keeps the first appearance of each stable catalog code,
// up to limit works.
func uniqueRankingWorks(works []kikoeru.Work, limit int) []kikoeru.Work {
	result := make([]kikoeru.Work, 0, len(works))
	seen := map[string]bool{}
	for _, work := range works {
		code := normalizedRemoteWorkCode(work)
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		result = append(result, work)
		if limit > 0 && len(result) >= limit {
			break
		}
	}
	return result
}

func (s *Server) executeRankingPullJob(ctx context.Context, job workflowJobRecord) error {
	return s.executeRankingPullJobWith(ctx, job, serverRankingPuller{server: s, dlsite: s.newDLsiteClient()}, time.Now)
}

// rankingPullTask is one variant of one list a run pulls.
type rankingPullTask struct {
	list    rankingList
	variant rankingVariant
	pull    rankingPull
	err     error
}

func (s *Server) executeRankingPullJobWith(ctx context.Context, job workflowJobRecord, puller rankingPuller, now func() time.Time) error {
	var payload rankingJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Ranking pull input is invalid")
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", job.RunID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", nodeIDs["pull"]); err != nil {
		return err
	}
	// The run takes the lists that are due when it starts, including those
	// that became due while it waited for the provider.
	startedAt := now().UTC()
	where := `list.enabled = 1 AND list.provider = ?
		AND (list.pull_requested_at IS NOT NULL OR (list.final_at IS NULL AND list.next_pull_at IS NOT NULL AND list.next_pull_at <= ?))`
	args := []any{payload.Provider, formatWorkflowTimestamp(startedAt)}
	if payload.Provider == rankingProviderRemote {
		where += " AND list.file_source_id = ?"
		args = append(args, payload.SourceID)
	}
	lists, err := s.loadRankingLists(ctx, 0, where, args...)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Rankings could not be loaded")
		return err
	}
	tasks := []*rankingPullTask{}
	listIDs := make([]int64, 0, len(lists))
	for _, list := range lists {
		listIDs = append(listIDs, list.ID)
		for _, variant := range list.Variants {
			tasks = append(tasks, &rankingPullTask{list: list, variant: variant})
		}
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "pull", map[string]any{"listIds": listIDs}, 0, len(tasks))
	result := rankingRunResult{RunID: job.RunID, JobID: job.ID, WorkflowCode: rankingWorkflowCodeFor(payload.Provider), Lists: []rankingListOutcome{}, Failures: []string{}}
	pullFailures := []string{}
	for index, task := range tasks {
		if err := ctx.Err(); err != nil {
			return err
		}
		task.pull, task.err = puller.pull(ctx, task.list, task.variant)
		if task.err != nil {
			message := fmt.Sprintf("%s: %s", rankingVariantLabel(task.list, task.variant), task.err.Error())
			pullFailures = append(pullFailures, message)
			_ = s.recordWorkflowRunEvent(ctx, job.RunID, "warning", "ranking_pull_failed", message, map[string]any{"list_id": task.list.ID, "variant_id": task.variant.ID})
		}
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "pull", map[string]any{"listIds": listIDs, "pulled": index + 1}, index+1, len(tasks))
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", nodeIDs["record"]); err != nil {
		return err
	}
	recordFailures := []string{}
	failedByList := map[int64][]*rankingPullTask{}
	for _, task := range tasks {
		outcome := rankingListOutcome{ListID: task.list.ID, VariantID: task.variant.ID, ReleaseWindow: task.variant.ReleaseWindow, Sort: task.variant.Sort}
		if task.err == nil {
			recorded, err := s.recordRankingPull(ctx, task.variant, job.RunID, task.pull, now().UTC())
			if err == nil {
				recorded.ListID, recorded.ReleaseWindow, recorded.Sort = task.list.ID, task.variant.ReleaseWindow, task.variant.Sort
				result.Lists = append(result.Lists, recorded)
				continue
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			task.err = err
			recordFailures = append(recordFailures, fmt.Sprintf("%s: %s", rankingVariantLabel(task.list, task.variant), err.Error()))
			slog.Warn("ranking snapshot could not be recorded", "list_id", task.list.ID, "variant_id", task.variant.ID, "error", err)
		}
		outcome.Status = rankingFailureStatus(task.err)
		result.Lists = append(result.Lists, outcome)
		failedByList[task.list.ID] = append(failedByList[task.list.ID], task)
		if err := s.recordRankingVariantFailure(ctx, task.variant, outcome.Status, task.err.Error()); err != nil {
			slog.Warn("ranking pull failure could not be recorded", "variant_id", task.variant.ID, "error", err)
		}
	}
	for _, list := range lists {
		failed := failedByList[list.ID]
		status, message := "succeeded", ""
		if len(failed) > 0 {
			status, message = rankingFailureStatus(failed[0].err), failed[0].err.Error()
			if len(failed) < len(list.Variants) {
				status = "partial"
			}
		}
		final, err := s.recordRankingListPull(ctx, list, status, message, now().UTC())
		if err != nil {
			slog.Warn("ranking schedule could not be recorded", "list_id", list.ID, "error", err)
			continue
		}
		if final {
			for index := range result.Lists {
				if result.Lists[index].ListID == list.ID {
					result.Lists[index].Final = true
				}
			}
		}
	}
	result.Failures = append(append(result.Failures, pullFailures...), recordFailures...)
	succeeded := len(tasks) - len(result.Failures)
	switch {
	case len(result.Failures) == 0:
		result.Status = "succeeded"
	case succeeded > 0:
		result.Status = "partial"
	default:
		result.Status = "failed"
	}
	err = s.finishRankingPullJob(ctx, job, nodeIDs, result, pullFailures, recordFailures)
	s.refreshRankingDispatchersBestEffort(ctx)
	return err
}

func rankingFailureStatus(err error) string {
	if errors.Is(err, errRankingSourceUnavailable) {
		return "source_unavailable"
	}
	return "failed"
}

// rankingVariantLabel names a list's order in run logs.
func rankingVariantLabel(list rankingList, variant rankingVariant) string {
	if list.Provider == rankingProviderRemote {
		return "remote source " + firstNonEmpty(list.SourceName, "ranking")
	}
	label := "DLsite " + list.Period
	if list.Period == "year" {
		label = fmt.Sprintf("DLsite year %d", list.Year)
	}
	if variant.ReleaseWindow != "" {
		label += " (" + variant.ReleaseWindow + ")"
	}
	if variant.Sort != "" {
		label += " by " + variant.Sort
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

// recordRankingPull stores one successful pull of a variant. An order equal to
// the variant's latest snapshot only refreshes the display text and moves that
// snapshot's confirmation forward; any other order becomes a new snapshot and
// updates each entry's streak, best rank, and appearances.
func (s *Server) recordRankingPull(ctx context.Context, variant rankingVariant, runID int64, pull rankingPull, now time.Time) (rankingListOutcome, error) {
	outcome := rankingListOutcome{VariantID: variant.ID, Status: "succeeded", Items: len(pull.Items), SkippedWithoutCode: pull.SkippedWithoutCode}
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
		SELECT id, content_hash FROM ranking_snapshot WHERE ranking_variant_id = ? ORDER BY pulled_at DESC, id DESC LIMIT 1
	`, variant.ID).Scan(&latestID, &latestHash)
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
			INSERT INTO ranking_snapshot (ranking_variant_id, pulled_at, confirmed_until, workflow_run_id, item_count, content_hash) VALUES (?, ?, ?, ?, ?, ?)
		`, variant.ID, pulledAt, pulledAt, run, len(pull.Items), hash)
		if err != nil {
			return outcome, err
		}
		if snapshotID, err = inserted.LastInsertId(); err != nil {
			return outcome, err
		}
	} else if _, err := tx.ExecContext(ctx, `
		UPDATE ranking_snapshot SET confirmed_until = MAX(COALESCE(confirmed_until, pulled_at), ?) WHERE id = ?
	`, pulledAt, latestID); err != nil {
		return outcome, err
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
				WHERE ranking_variant_id = ? AND primary_code = ?
			`, title, title, maker, maker, item.RemoteWorkID, item.RemoteWorkID, item.CoverURL, item.CoverURL, variant.ID, item.Code); err != nil {
				return outcome, err
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO ranking_snapshot_item (snapshot_id, rank, primary_code) VALUES (?, ?, ?)", snapshotID, rank, item.Code); err != nil {
			return outcome, err
		}
		var known bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM ranking_entry WHERE ranking_variant_id = ? AND primary_code = ?)", variant.ID, item.Code).Scan(&known); err != nil {
			return outcome, err
		}
		if !known {
			outcome.New++
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO ranking_entry (ranking_variant_id, primary_code, title, maker_name, remote_work_id, remote_cover_url,
					first_seen_at, streak_started_at, last_seen_at, best_rank, appearances)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
			`, variant.ID, item.Code, title, maker, item.RemoteWorkID, item.CoverURL, pulledAt, pulledAt, pulledAt, rank); err != nil {
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
			WHERE ranking_variant_id = ? AND primary_code = ?
		`, title, title, maker, maker, item.RemoteWorkID, item.RemoteWorkID, item.CoverURL, item.CoverURL,
			continuing, pulledAt, pulledAt, rank, variant.ID, item.Code); err != nil {
			return outcome, err
		}
	}
	if outcome.Changed {
		for code := range previous {
			if !current[code] {
				outcome.Dropped++
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ranking_variant SET last_pulled_at = ?, last_status = 'succeeded', last_error = '' WHERE id = ?
	`, pulledAt, variant.ID); err != nil {
		return outcome, err
	}
	return outcome, tx.Commit()
}

// recordRankingVariantFailure keeps the variant's last snapshot; the detailed
// error stays in the protected last_error.
func (s *Server) recordRankingVariantFailure(ctx context.Context, variant rankingVariant, status, message string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ranking_variant SET last_status = ?, last_error = ? WHERE id = ?`, status, message, variant.ID)
	return err
}

// recordRankingListPull schedules a list after a pull of its variants. A pull
// whose every variant succeeded plans the next one an interval later; any
// failed variant spaces out the retries. An annual list pulled completely
// after its year is finalized and, when it follows the current year, adds the
// list of the year in progress.
func (s *Server) recordRankingListPull(ctx context.Context, list rankingList, status, message string, now time.Time) (bool, error) {
	pulledAt := formatWorkflowTimestamp(now)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	if status != "succeeded" {
		failures := list.failureCount + 1
		lastPulledAt := any(nil)
		if list.LastPulledAt != nil {
			lastPulledAt = *list.LastPulledAt
		}
		if status == "partial" {
			lastPulledAt = pulledAt
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ranking_list
			SET last_status = ?, last_error = ?, failure_count = ?, pull_requested_at = NULL, next_pull_at = ?, last_pulled_at = ?
			WHERE id = ?
		`, status, message, failures, formatOptionalWorkflowTimestamp(rankingRetryPullAt(list, failures, now)), lastPulledAt, list.ID); err != nil {
			return false, err
		}
		return false, tx.Commit()
	}
	var finalAt any
	final := false
	if list.FinalAt != nil {
		finalAt = *list.FinalAt
	} else if list.Period == "year" && !now.Before(rankingFinalPullAt(list.Year)) {
		finalAt, final = pulledAt, true
		list.FinalAt = &pulledAt
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ranking_list
		SET last_pulled_at = ?, last_status = 'succeeded', last_error = '', failure_count = 0,
			pull_requested_at = NULL, next_pull_at = ?, final_at = ?
		WHERE id = ?
	`, pulledAt, formatOptionalWorkflowTimestamp(nextRankingPullAt(list, now)), finalAt, list.ID); err != nil {
		return false, err
	}
	if final && list.FollowCurrentYear {
		if err := followRankingYear(ctx, tx, list, now); err != nil {
			return false, err
		}
	}
	return final, tx.Commit()
}

// followRankingYear adds the list of the year in progress with the finalized
// list's settings and orders, and asks for its first pull.
func followRankingYear(ctx context.Context, tx *sql.Tx, list rankingList, now time.Time) error {
	year := currentRankingYear(now)
	if year <= list.Year {
		return nil
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO ranking_list (provider, period, year, depth, enabled, auto_refresh, refresh_interval_minutes,
			follow_current_year, pull_requested_at)
		VALUES ('dlsite', 'year', ?, ?, ?, ?, ?, 1, ?)
		ON CONFLICT DO NOTHING
	`, year, list.Depth, list.Enabled, list.AutoRefresh, list.RefreshIntervalMinutes, formatWorkflowTimestamp(now))
	if err != nil {
		return err
	}
	if inserted, _ := result.RowsAffected(); inserted == 0 {
		return nil
	}
	id, err := result.LastInsertId()
	if err != nil {
		return err
	}
	return ensureRankingVariants(ctx, tx, id, rankingProviderDLsite, "year")
}

func (s *Server) finishRankingPullJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, result rankingRunResult, pullFailures, recordFailures []string) error {
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
		{"pull", nodeStatus(pullFailures, pulled+len(recordFailures)), map[string]any{"variants": len(result.Lists), "failed": len(pullFailures)}, pullFailures},
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
	} else if err := updateWorkflowTriggerFailure(ctx, tx, job.RunID, "Ranking pull completed with some failures"); err != nil {
		return err
	}
	return tx.Commit()
}
