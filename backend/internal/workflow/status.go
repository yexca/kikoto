package workflow

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

// DefinitionStatus states where one system workflow stands, from the runs a
// viewer may see. Callers read it instead of working the status out of run
// lists, so it holds however many runs are active.
type DefinitionStatus struct {
	DefinitionID int64  `json:"definitionId"`
	Code         string `json:"code"`
	// StageCount is the number of stages the definition declares.
	StageCount int `json:"stageCount"`
	// LatestRun is the newest run of any status; null when it never ran.
	LatestRun *RunRecord `json:"latestRun"`
	// CurrentRun is the run that states the workflow's status: the newest
	// running run, else the newest queued run, else the latest run.
	CurrentRun *RunRecord `json:"currentRun"`
	// ActiveRuns counts the queued and running runs.
	ActiveRuns int64 `json:"activeRuns"`
	// NeedsReview marks a current run that ended with candidates or
	// retryable metadata failures still waiting for a decision.
	NeedsReview bool `json:"needsReview"`
	// NextRunAt is the soonest next run among the enabled interval schedules.
	NextRunAt *string `json:"nextRunAt"`
}

// StatusOptions selects the workflows and the viewer whose visible runs
// state their status.
type StatusOptions struct {
	// Codes limits the answer to these workflow codes; empty selects every
	// system workflow.
	Codes        []string
	ViewerUserID int64
	CanViewAll   bool
	DemoShowcase bool
}

// ListDefinitionStatuses returns the status of each system workflow, ordered
// by code.
func (s *Store) ListDefinitionStatuses(ctx context.Context, options StatusOptions) ([]DefinitionStatus, error) {
	statuses, err := s.loadStatusDefinitions(ctx, options.Codes)
	if err != nil || len(statuses) == 0 {
		return statuses, err
	}
	byCode := make(map[string]*DefinitionStatus, len(statuses))
	codeArgs := make([]any, 0, len(statuses))
	for index := range statuses {
		byCode[statuses[index].Code] = &statuses[index]
		codeArgs = append(codeArgs, statuses[index].Code)
	}
	codeMarks := strings.TrimSuffix(strings.Repeat("?,", len(codeArgs)), ",")
	baseWhere, _, baseArgs := buildRunListConditions(ListRunsOptions{
		ViewerUserID: options.ViewerUserID, CanViewAll: options.CanViewAll, DemoShowcase: options.DemoShowcase,
	})
	where := baseWhere + " AND run.workflow_code IN (" + codeMarks + ")"
	args := append(append([]any{}, baseArgs...), codeArgs...)

	counts, err := s.db.QueryContext(ctx, `SELECT run.workflow_code, COUNT(*) FROM workflow_run AS run
		WHERE `+where+` AND `+runningRunCondition+` GROUP BY run.workflow_code`, args...)
	if err != nil {
		return nil, err
	}
	for counts.Next() {
		var code string
		var count int64
		if err := counts.Scan(&code, &count); err != nil {
			_ = counts.Close()
			return nil, err
		}
		byCode[code].ActiveRuns = count
	}
	if err := counts.Close(); err != nil {
		return nil, err
	}

	// The latest run and the current run of each workflow, in one pass over
	// the runs: the first by recency, the second with active runs ahead of
	// finished ones and a running run ahead of a queued one.
	picks, err := s.db.QueryContext(ctx, `SELECT code, latest_id, current_id FROM (
		SELECT run.workflow_code AS code,
			FIRST_VALUE(run.id) OVER by_recency AS latest_id,
			FIRST_VALUE(run.id) OVER by_activity AS current_id,
			ROW_NUMBER() OVER by_recency AS position
		FROM workflow_run AS run WHERE `+where+`
		WINDOW by_recency AS (PARTITION BY run.workflow_code ORDER BY run.created_at DESC, run.id DESC),
			by_activity AS (PARTITION BY run.workflow_code ORDER BY
				CASE run.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, run.created_at DESC, run.id DESC)
	) WHERE position = 1`, args...)
	if err != nil {
		return nil, err
	}
	latestIDs := map[string]int64{}
	currentIDs := map[string]int64{}
	for picks.Next() {
		var code string
		var latestID, currentID int64
		if err := picks.Scan(&code, &latestID, &currentID); err != nil {
			_ = picks.Close()
			return nil, err
		}
		latestIDs[code], currentIDs[code] = latestID, currentID
	}
	if err := picks.Close(); err != nil {
		return nil, err
	}
	runs, err := s.loadStatusRuns(ctx, options.ViewerUserID, latestIDs, currentIDs)
	if err != nil {
		return nil, err
	}
	for code, status := range byCode {
		if id, ok := latestIDs[code]; ok {
			latest := runs[id]
			status.LatestRun = &latest
		}
		if id, ok := currentIDs[code]; ok {
			current := runs[id]
			status.CurrentRun = &current
			status.NeedsReview = runNeedsReview(current)
		}
	}
	if err := s.loadNextRunTimes(ctx, byCode); err != nil {
		return nil, err
	}
	return statuses, nil
}

// runNeedsReview reports a run that has ended with something waiting for a
// decision: candidates to review or metadata failures to retry.
func runNeedsReview(run RunRecord) bool {
	if run.Status == "queued" || run.Status == "running" {
		return false
	}
	return run.PendingCandidates > 0 || run.PendingFailedMetadata > 0
}

func (s *Store) loadStatusDefinitions(ctx context.Context, codes []string) ([]DefinitionStatus, error) {
	query := `SELECT id, code, definition_json FROM workflow_definition WHERE scope = 'system'`
	args := []any{}
	if len(codes) > 0 {
		query += ` AND code IN (` + strings.TrimSuffix(strings.Repeat("?,", len(codes)), ",") + `)`
		for _, code := range codes {
			args = append(args, code)
		}
	}
	rows, err := s.db.QueryContext(ctx, query+` ORDER BY code`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	statuses := []DefinitionStatus{}
	for rows.Next() {
		var status DefinitionStatus
		var definitionJSON string
		if err := rows.Scan(&status.DefinitionID, &status.Code, &definitionJSON); err != nil {
			return nil, err
		}
		status.StageCount = definitionStageCount(definitionJSON)
		statuses = append(statuses, status)
	}
	return statuses, rows.Err()
}

func (s *Store) loadStatusRuns(ctx context.Context, viewerUserID int64, groups ...map[string]int64) (map[int64]RunRecord, error) {
	seen := map[int64]bool{}
	args := []any{}
	for _, group := range groups {
		for _, id := range group {
			if !seen[id] {
				seen[id] = true
				args = append(args, id)
			}
		}
	}
	runs := make(map[int64]RunRecord, len(args))
	if len(args) == 0 {
		return runs, nil
	}
	rows, err := s.db.QueryContext(ctx, runSelectSQL(" AND review.user_id = "+strconv.FormatInt(viewerUserID, 10))+
		` FROM workflow_run AS run WHERE run.id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(args)), ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	loaded, err := scanRuns(rows)
	if err != nil {
		return nil, err
	}
	for _, run := range loaded {
		runs[run.ID] = run
	}
	return runs, nil
}

// loadNextRunTimes sets each workflow's soonest next run among its enabled
// interval schedules. Next run times share one sortable format.
func (s *Store) loadNextRunTimes(ctx context.Context, byCode map[string]*DefinitionStatus) error {
	byDefinition := make(map[int64]*DefinitionStatus, len(byCode))
	for _, status := range byCode {
		byDefinition[status.DefinitionID] = status
	}
	rows, err := s.db.QueryContext(ctx, `SELECT workflow_definition_id, MIN(next_run_at) FROM workflow_trigger
		WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at IS NOT NULL AND next_run_at != ''
		GROUP BY workflow_definition_id`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var definitionID int64
		var nextRunAt string
		if err := rows.Scan(&definitionID, &nextRunAt); err != nil {
			return err
		}
		if status, ok := byDefinition[definitionID]; ok {
			status.NextRunAt = &nextRunAt
		}
	}
	return rows.Err()
}

// definitionStageCount counts the nodes a definition declares; a node needs a
// non-empty id and type.
func definitionStageCount(definitionJSON string) int {
	var definition struct {
		Nodes []json.RawMessage `json:"nodes"`
	}
	if json.Unmarshal([]byte(definitionJSON), &definition) != nil {
		return 0
	}
	count := 0
	for _, raw := range definition.Nodes {
		var node struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &node) == nil && node.ID != "" && node.Type != "" {
			count++
		}
	}
	return count
}
