package metasync

import (
	"context"
	"database/sql"
	"strings"
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
	where := "state.status IN ('failed', 'unavailable')"
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
		WHERE state.status IN ('failed', 'unavailable')
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
	return page, rows.Err()
}

func (s *IssueStore) HasPendingDLsite(ctx context.Context, workID int64) (bool, error) {
	var pending bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM work_metadata_sync_state AS state
		INNER JOIN metadata_provider AS provider ON provider.id = state.provider_id
		WHERE state.work_id = ? AND provider.code = 'dlsite' AND state.status IN ('failed', 'unavailable'))`, workID).Scan(&pending)
	return pending, err
}

type RunIssueSummary struct {
	Encountered int `json:"encountered"`
	Pending     int `json:"pending"`
}

func (s *IssueStore) ForRun(ctx context.Context, runID int64) (RunIssueSummary, error) {
	var summary RunIssueSummary
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT tried.work_id),
		COUNT(DISTINCT CASE WHEN state.status IN ('failed', 'unavailable') AND state.last_success_attempt_id <= tried.attempt_id THEN tried.work_id END)
		FROM metadata_sync_attempt_run AS run
		INNER JOIN metadata_sync_attempt_work AS tried ON tried.attempt_id = run.attempt_id
		LEFT JOIN work_metadata_sync_state AS state ON state.work_id = tried.work_id AND state.provider_id = tried.provider_id AND state.component = tried.component
		WHERE run.workflow_run_id = ? AND tried.status != 'succeeded'`, runID).Scan(&summary.Encountered, &summary.Pending)
	return summary, err
}
