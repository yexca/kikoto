package metasync

import (
	"context"
	"database/sql"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workcode"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type Issue struct {
	Component     string `json:"component"`
	Status        string `json:"status"`
	FailureCount  int    `json:"failureCount"`
	FirstFailedAt string `json:"firstFailedAt"`
	CheckedAt     string `json:"checkedAt"`
}

type IssueWork struct {
	WorkID       int64   `json:"workId"`
	PrimaryCode  string  `json:"primaryCode"`
	Title        string  `json:"title"`
	ProviderCode string  `json:"providerCode"`
	ProviderName string  `json:"providerName"`
	FamilyCode   string  `json:"-"`
	FamilyWorkID int64   `json:"-"`
	Retrying     bool    `json:"retrying"`
	Issues       []Issue `json:"issues"`
}

type IssueQuery struct {
	Page          int
	PageSize      int
	RunID         int64
	Search        string
	Status        string
	FamilyWorkIDs []int64
}

type IssuePage struct {
	Items    []IssueWork `json:"items"`
	Total    int         `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
}

type IssueStore struct{ db *sql.DB }

func NewIssueStore(db *sql.DB) *IssueStore { return &IssueStore{db: db} }

func issueFilter(query IssueQuery) (string, []any) {
	where := workflow.PendingMetadataState
	args := []any{}
	if query.Status != "" {
		where += " AND state.status = ?"
		args = append(args, query.Status)
	}
	if query.Search != "" {
		where += " AND (instr(LOWER(work.primary_code), ?) > 0 OR instr(LOWER(work.title), ?) > 0)"
		args = append(args, strings.ToLower(query.Search), strings.ToLower(query.Search))
	}
	if query.RunID > 0 {
		where += ` AND EXISTS (SELECT 1 FROM metadata_sync_attempt_work AS tried
			INNER JOIN metadata_sync_attempt_run AS run ON run.attempt_id = tried.attempt_id
			WHERE run.workflow_run_id = ? AND tried.work_id = state.work_id AND tried.provider_id = state.provider_id
				AND tried.component = state.component AND tried.status != 'succeeded'
				AND state.last_success_attempt_id <= tried.attempt_id)`
		args = append(args, query.RunID)
	}
	return where, args
}

// PendingFamilyPredicate is a trusted SQL predicate for a projection whose
// representative work is aliased as work. It includes failures on any edition.
func PendingFamilyPredicate(runID int64) (string, []any) {
	where, args := issueFilter(IssueQuery{RunID: runID})
	return `EXISTS (SELECT 1 FROM work_metadata_sync_state AS state WHERE ` + where + `
		AND (state.work_id = work.id OR state.work_id IN (
			SELECT sibling.work_id FROM work_edition AS current_edition
			JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
			WHERE current_edition.work_id = work.id)))`, args
}

// ListForFamilies returns pending edition/provider details only for a bounded
// page of selected families. Pagination belongs to the family projection.
func (s *IssueStore) ListForFamilies(ctx context.Context, ids []int64) ([]IssueWork, error) {
	if len(ids) == 0 {
		return []IssueWork{}, nil
	}
	page, err := s.List(ctx, IssueQuery{Page: 1, PageSize: -1, FamilyWorkIDs: ids})
	return page.Items, err
}

func (s *IssueStore) List(ctx context.Context, query IssueQuery) (IssuePage, error) {
	page := IssuePage{Items: []IssueWork{}, Page: query.Page, PageSize: query.PageSize}
	where, args := issueFilter(query)
	if len(query.FamilyWorkIDs) > 0 {
		marks := make([]string, len(query.FamilyWorkIDs))
		for i, id := range query.FamilyWorkIDs {
			marks[i] = "?"
			args = append(args, id)
		}
		where += ` AND (state.work_id IN (` + strings.Join(marks, ",") + `) OR state.work_id IN (
			SELECT sibling.work_id FROM work_edition AS selected JOIN work_edition AS sibling
			ON sibling.logical_work_id = selected.logical_work_id WHERE selected.work_id IN (` + strings.Join(marks, ",") + `)))`
		for _, id := range query.FamilyWorkIDs {
			args = append(args, id)
		}
	}
	from := ` FROM work_metadata_sync_state AS state INNER JOIN work ON work.id = state.work_id WHERE ` + where
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM (SELECT state.work_id, state.provider_id"+from+" GROUP BY state.work_id, state.provider_id)", args...).Scan(&page.Total); err != nil {
		return page, err
	}
	// Page work/provider groups before joining their components, so a work with
	// both metadata and cover failures occupies exactly one selectable row.
	rows, err := s.db.QueryContext(ctx, `WITH selected AS (
		SELECT state.work_id, state.provider_id, MAX(state.checked_at) AS checked_at`+from+`
		GROUP BY state.work_id, state.provider_id ORDER BY checked_at DESC, state.work_id, state.provider_id LIMIT ? OFFSET ?)
		SELECT work.id, work.primary_code, work.title, provider.code, provider.display_name,
			COALESCE(NULLIF(logical.canonical_code, ''), work.primary_code),
			COALESCE(logical.canonical_work_id, (SELECT MIN(sibling.work_id) FROM work_edition AS sibling WHERE sibling.logical_work_id = logical.id), work.id),
			EXISTS (SELECT 1 FROM workflow_job AS job
				WHERE job.worker_type = 'metadata_family_sync' AND job.status IN ('queued', 'running')
				AND json_extract(job.payload_json, '$.familyCode') = COALESCE(NULLIF(logical.canonical_code, ''), work.primary_code)),
			state.component, state.status, state.failure_count, COALESCE(state.first_failed_at, ''), state.checked_at
		FROM selected INNER JOIN work ON work.id = selected.work_id
		INNER JOIN metadata_provider AS provider ON provider.id = selected.provider_id
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		INNER JOIN work_metadata_sync_state AS state ON state.work_id = selected.work_id AND state.provider_id = selected.provider_id
		WHERE `+workflow.PendingMetadataState+`
		ORDER BY selected.checked_at DESC, work.id, provider.id, state.component`,
		append(args, query.PageSize, (query.Page-1)*query.PageSize)...)
	if err != nil {
		return page, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var work IssueWork
		var issue Issue
		if err := rows.Scan(&work.WorkID, &work.PrimaryCode, &work.Title, &work.ProviderCode, &work.ProviderName,
			&work.FamilyCode, &work.FamilyWorkID, &work.Retrying, &issue.Component, &issue.Status, &issue.FailureCount, &issue.FirstFailedAt, &issue.CheckedAt); err != nil {
			return page, err
		}
		last := len(page.Items) - 1
		if last >= 0 && page.Items[last].WorkID == work.WorkID && page.Items[last].ProviderCode == work.ProviderCode {
			page.Items[last].Issues = append(page.Items[last].Issues, issue)
		} else {
			work.Issues = []Issue{issue}
			page.Items = append(page.Items, work)
		}
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if err := rows.Close(); err != nil {
		return page, err
	}
	return page, nil
}

// familyMemberCondition matches member against the family of the
// representative work aliased as work: the work itself and every edition.
const familyMemberCondition = `(member.id = work.id OR member.id IN (
	SELECT sibling.work_id FROM work_edition AS current_edition
	JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
	WHERE current_edition.work_id = work.id))`

// familyCodeExpression is the code a family sync job is keyed by, for a
// representative work joined to its optional logical family as logical.
const familyCodeExpression = `COALESCE(NULLIF(logical.canonical_code, ''), work.primary_code)`

// NotSyncedFamilyPredicate is a trusted SQL predicate for a projection whose
// representative work is aliased as work. It holds for a catalog family whose
// editions have no DLsite attempt outcome, provider state, or stored snapshot,
// so the family has no catalog metadata yet. Custom works are never synced.
func NotSyncedFamilyPredicate() string {
	return `(work.primary_code NOT LIKE '` + workcode.CustomPrefix + `%' AND NOT EXISTS (SELECT 1 FROM work AS member
		JOIN metadata_provider AS dlsite ON dlsite.code = 'dlsite'
		WHERE ` + familyMemberCondition + ` AND (
			EXISTS (SELECT 1 FROM work_metadata_sync_state AS synced WHERE synced.work_id = member.id AND synced.provider_id = dlsite.id)
			OR EXISTS (SELECT 1 FROM work_metadata_provider_state AS checked WHERE checked.work_id = member.id AND checked.provider_id = dlsite.id)
			OR EXISTS (SELECT 1 FROM metadata_snapshot AS snapshot WHERE snapshot.work_id = member.id AND snapshot.provider_id = dlsite.id))))`
}

// FamilyState is a listed family's catalog metadata state beyond its pending
// issues.
type FamilyState struct {
	NotSynced bool
	// Syncing holds while the family's sync job is queued or running.
	Syncing    bool
	FamilyCode string
	// RemoteSource names the remote source that filled the family's metadata,
	// preferring the representative work and its title.
	RemoteSource string
}

// FamilyStates reads the state of a bounded page of family representatives.
func (s *IssueStore) FamilyStates(ctx context.Context, ids []int64) (map[int64]FamilyState, error) {
	states := map[int64]FamilyState{}
	if len(ids) == 0 {
		return states, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := s.db.QueryContext(ctx, `SELECT work.id, `+familyCodeExpression+`, `+NotSyncedFamilyPredicate()+`,
			EXISTS (SELECT 1 FROM workflow_job AS job
				WHERE job.worker_type = 'metadata_family_sync' AND job.status IN ('queued', 'running')
				AND json_extract(job.payload_json, '$.familyCode') = `+familyCodeExpression+`),
			COALESCE((SELECT provider.display_name FROM work AS member
				JOIN work_metadata_field_source AS source ON source.work_id = member.id
				JOIN metadata_provider AS provider ON provider.id = source.provider_id
				WHERE `+familyMemberCondition+`
				ORDER BY member.id = work.id DESC, CASE source.field_name WHEN 'title' THEN 0 ELSE 1 END, source.field_name, member.id
				LIMIT 1), '')
		FROM work
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE work.id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var state FamilyState
		if err := rows.Scan(&id, &state.FamilyCode, &state.NotSynced, &state.Syncing, &state.RemoteSource); err != nil {
			return nil, err
		}
		states[id] = state
	}
	return states, rows.Err()
}

// NeedsDLsiteRecovery reports whether explicit recovery may queue the work's
// family: the work has a pending DLsite issue, or its family was never synced.
func (s *IssueStore) NeedsDLsiteRecovery(ctx context.Context, workID int64) (bool, error) {
	var needed bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM work_metadata_sync_state AS state
		INNER JOIN metadata_provider AS provider ON provider.id = state.provider_id
		WHERE state.work_id = ? AND provider.code = 'dlsite' AND `+workflow.PendingMetadataState+`)
		OR EXISTS (SELECT 1 FROM work WHERE work.id = ? AND `+NotSyncedFamilyPredicate()+`)`, workID, workID).Scan(&needed)
	return needed, err
}

type RunIssueSummary struct {
	Encountered int `json:"encountered"`
	Pending     int `json:"pending"`
}

func (s *IssueStore) ForRun(ctx context.Context, runID int64) (RunIssueSummary, error) {
	var summary RunIssueSummary
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT tried.work_id),
		COUNT(DISTINCT CASE WHEN `+workflow.PendingMetadataState+` AND state.last_success_attempt_id <= tried.attempt_id THEN tried.work_id END)
		FROM metadata_sync_attempt_run AS run
		INNER JOIN metadata_sync_attempt_work AS tried ON tried.attempt_id = run.attempt_id
		LEFT JOIN work_metadata_sync_state AS state ON state.work_id = tried.work_id AND state.provider_id = tried.provider_id AND state.component = tried.component
		WHERE run.workflow_run_id = ? AND tried.status != 'succeeded'`, runID).Scan(&summary.Encountered, &summary.Pending)
	return summary, err
}
