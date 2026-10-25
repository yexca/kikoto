package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// Each ranking list keeps its own pull schedule. The two popular collection
// workflows pull them: one DLsite run takes every due DLsite list, and one
// remote run takes the due lists of one source. Each workflow keeps one
// ownerless schedule trigger as its dispatcher, whose next run is the earliest
// time one of its lists is due.

const (
	dlsiteRankingWorkflowCode = "dlsite_popular_collection"
	remoteRankingWorkflowCode = "remote_popular_collection"

	// rankingDispatchRetryDelay spaces out dispatch attempts that could not
	// queue a run, so a failing dispatcher does not hold the scheduler.
	rankingDispatchRetryDelay = 5 * time.Minute
)

var rankingWorkflowCodes = []string{dlsiteRankingWorkflowCode, remoteRankingWorkflowCode}

func isRankingWorkflowCode(code string) bool {
	return code == dlsiteRankingWorkflowCode || code == remoteRankingWorkflowCode
}

// rankingWorkflowCodeFor names the workflow that pulls a provider's lists.
func rankingWorkflowCodeFor(provider string) string {
	if provider == rankingProviderRemote {
		return remoteRankingWorkflowCode
	}
	return dlsiteRankingWorkflowCode
}

// rankingIntervalRange is the default and the choice of intervals, in minutes,
// for one kind of list.
type rankingIntervalRange struct {
	Default, Min, Max int
}

// rankingIntervalRangeFor follows how often each ranking changes: DLsite
// updates its 24-hour ranking every 20 minutes, its 7-day ranking hourly, and
// its 30-day ranking daily; the annual and all-time rankings change slowly.
func rankingIntervalRangeFor(provider, period string) rankingIntervalRange {
	switch {
	case provider == rankingProviderRemote:
		return rankingIntervalRange{Default: 24 * 60, Min: 60, Max: 7 * 24 * 60}
	case period == "day":
		return rankingIntervalRange{Default: 60, Min: 20, Max: 24 * 60}
	case period == "week":
		return rankingIntervalRange{Default: 6 * 60, Min: 60, Max: 7 * 24 * 60}
	case period == "month":
		return rankingIntervalRange{Default: 24 * 60, Min: 6 * 60, Max: 7 * 24 * 60}
	default: // year and total
		return rankingIntervalRange{Default: 7 * 24 * 60, Min: 24 * 60, Max: 30 * 24 * 60}
	}
}

// rankingFinalPullAt is when an annual list's year is settled: from 3 January
// in Japan after the year, one last pull records the final order.
func rankingFinalPullAt(year int) time.Time {
	// Midnight in Japan is 15:00 UTC on the day before.
	return time.Date(year+1, time.January, 2, 15, 0, 0, 0, time.UTC)
}

// currentRankingYear is the year of the DLsite annual ranking in progress.
func currentRankingYear(now time.Time) int {
	return dlsite.CurrentRankingYear(now)
}

// nextRankingPullAt is when a list is next due after a pull at from, or nil
// when nothing schedules it. An annual list is always pulled once more after
// its year, even with automatic pulls off.
func nextRankingPullAt(list rankingList, from time.Time) *time.Time {
	if list.FinalAt != nil {
		return nil
	}
	var next *time.Time
	if list.AutoRefresh {
		at := from.Add(time.Duration(list.RefreshIntervalMinutes) * time.Minute).UTC()
		next = &at
	}
	if list.Period == "year" {
		final := rankingFinalPullAt(list.Year)
		if next == nil || final.Before(*next) {
			next = &final
		}
	}
	return next
}

// rankingRetryPullAt spaces out the retries after failed pulls: one hour after
// the first failure, two after the second, and so on, never longer than the
// list's interval. A list without automatic pulls is not retried until its
// scheduled final pull.
func rankingRetryPullAt(list rankingList, failures int, now time.Time) *time.Time {
	natural := nextRankingPullAt(list, now)
	if natural == nil {
		return nil
	}
	retry := now.Add(min(time.Duration(failures)*time.Hour, time.Duration(list.RefreshIntervalMinutes)*time.Minute)).UTC()
	if natural.After(now) && (natural.Before(retry) || !list.AutoRefresh) {
		return natural
	}
	return &retry
}

func formatOptionalWorkflowTimestamp(value *time.Time) any {
	if value == nil {
		return nil
	}
	return formatWorkflowTimestamp(*value)
}

func parseWorkflowTimestamp(value string) (time.Time, bool) {
	parsed, err := time.ParseInLocation("2006-01-02 15:04:05", value, time.UTC)
	return parsed, err == nil
}

// rankingPullTarget is what one pull run covers: every DLsite list, or the
// lists of one remote source.
type rankingPullTarget struct {
	Provider string
	SourceID int64
}

func (target rankingPullTarget) workflowCode() string {
	return rankingWorkflowCodeFor(target.Provider)
}

// rankingDueGroup is the earliest time any list of one target is due.
type rankingDueGroup struct {
	target rankingPullTarget
	dueAt  time.Time
	// later is the earliest due time after now, used while a run is active.
	later  *time.Time
	active bool
}

// rankingDueGroups reads the due times of a workflow's enabled lists per
// target. A requested pull is due at once; a list of a disabled or
// incompatible source is not dispatched.
func (s *Server) rankingDueGroups(ctx context.Context, code string, now time.Time) ([]rankingDueGroup, error) {
	provider := rankingProviderDLsite
	if code == remoteRankingWorkflowCode {
		provider = rankingProviderRemote
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT COALESCE(list.file_source_id, 0), list.pull_requested_at,
			CASE WHEN list.final_at IS NULL THEN list.next_pull_at END
		FROM ranking_list AS list
		LEFT JOIN file_source AS source ON source.id = list.file_source_id
		WHERE list.enabled = 1 AND list.provider = ?
			AND (list.pull_requested_at IS NOT NULL OR (list.final_at IS NULL AND list.next_pull_at IS NOT NULL))
			AND (list.provider = 'dlsite' OR (source.enabled = 1 AND source.source_type IN (?, ?)))
	`, provider, sourceTypeKikoeruCompatible, sourceTypeKikoeruCompatible178)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	groups := map[int64]*rankingDueGroup{}
	order := []int64{}
	for rows.Next() {
		var sourceID int64
		var requestedAt, nextPullAt sql.NullString
		if err := rows.Scan(&sourceID, &requestedAt, &nextPullAt); err != nil {
			return nil, err
		}
		group := groups[sourceID]
		if group == nil {
			group = &rankingDueGroup{target: rankingPullTarget{Provider: provider, SourceID: sourceID}}
			groups[sourceID] = group
			order = append(order, sourceID)
		}
		for _, raw := range []sql.NullString{requestedAt, nextPullAt} {
			at, ok := parseWorkflowTimestamp(raw.String)
			if !raw.Valid || !ok {
				continue
			}
			if group.dueAt.IsZero() || at.Before(group.dueAt) {
				group.dueAt = at
			}
			if at.After(now) && (group.later == nil || at.Before(*group.later)) {
				later := at
				group.later = &later
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]rankingDueGroup, 0, len(order))
	for _, sourceID := range order {
		group := groups[sourceID]
		if group.dueAt.IsZero() {
			continue
		}
		active, err := s.activeRankingRun(ctx, s.db, group.target)
		if err != nil {
			return nil, err
		}
		group.active = active.RunID > 0
		result = append(result, *group)
	}
	return result, nil
}

// nextRankingDispatchAt is when a workflow's dispatcher should run next: the
// earliest due list of a target without an active run, or, while a target's
// run is active, its earliest later due time. A finished run plans again.
func nextRankingDispatchAt(groups []rankingDueGroup) *time.Time {
	var next *time.Time
	for _, group := range groups {
		candidate := &group.dueAt
		if group.active {
			candidate = group.later
		}
		if candidate != nil && (next == nil || candidate.Before(*next)) {
			at := *candidate
			next = &at
		}
	}
	return next
}

// ensureRankingDispatchers keeps one dispatch trigger for each pulling
// workflow and plans it from the lists.
func (s *Server) ensureRankingDispatchers(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, code := range rankingWorkflowCodes {
		spec := rankingWorkflowSpec(code)
		definitionID, err := workflow.EnsureDefinition(ctx, tx, spec.Code, spec.Name, spec.Description, map[string]any{"nodes": spec.Nodes})
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
			SELECT ?, 'schedule', ?, 1, '{}', '{}'
			WHERE NOT EXISTS (SELECT 1 FROM workflow_trigger WHERE workflow_definition_id = ?)
		`, definitionID, spec.Name, definitionID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := s.reconcileInterruptedRankingSchedules(ctx); err != nil {
		return err
	}
	return s.refreshRankingDispatchers(ctx)
}

// refreshRankingDispatchers replans both dispatchers. Every change to a list's
// schedule and every finished pull calls it.
func (s *Server) refreshRankingDispatchers(ctx context.Context) error {
	now := time.Now().UTC()
	for _, code := range rankingWorkflowCodes {
		groups, err := s.rankingDueGroups(ctx, code, now)
		if err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx, `
			UPDATE workflow_trigger
			SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP
			WHERE trigger_type = 'schedule'
				AND workflow_definition_id IN (SELECT id FROM workflow_definition WHERE code = ?)
		`, formatOptionalWorkflowTimestamp(nextRankingDispatchAt(groups)), code); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) refreshRankingDispatchersBestEffort(ctx context.Context) {
	if err := s.refreshRankingDispatchers(context.WithoutCancel(ctx)); err != nil {
		slog.Warn("ranking dispatch could not be planned", "error", err)
	}
}

// dispatchRankingTrigger queues one run for each target with a due list and
// no active run, then plans the next dispatch. A run picks its lists when it
// starts, so a queued run also takes the lists that become due meanwhile.
func (s *Server) dispatchRankingTrigger(ctx context.Context, definition workflowDefinitionRecord, trigger workflowTriggerRecord) error {
	now := time.Now().UTC()
	claim, err := s.db.ExecContext(ctx, `
		UPDATE workflow_trigger SET last_run_at = ?, last_error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
	`, formatWorkflowTimestamp(now), trigger.ID, formatWorkflowTimestamp(now))
	if err != nil {
		return err
	}
	if claimed, err := claim.RowsAffected(); err != nil || claimed == 0 {
		return err
	}
	groups, err := s.rankingDueGroups(ctx, definition.Code, now)
	if err != nil {
		return err
	}
	var dispatchErr error
	for _, group := range groups {
		if group.active || group.dueAt.After(now) {
			continue
		}
		_, err := s.enqueueRankingPull(ctx, group.target, workflowRunTrigger{Type: "schedule", Reason: "rankings_due", ID: trigger.ID}, 0)
		if err != nil && !errors.Is(err, errRankingRunActive) && dispatchErr == nil {
			dispatchErr = err
		}
	}
	if err := s.refreshRankingDispatchers(ctx); err != nil {
		return err
	}
	if dispatchErr != nil {
		_, err := s.db.ExecContext(ctx, `
			UPDATE workflow_trigger SET next_run_at = ?, last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
		`, formatWorkflowTimestamp(now.Add(rankingDispatchRetryDelay)), dispatchErr.Error(), trigger.ID)
		if err != nil {
			return err
		}
		return dispatchErr
	}
	return nil
}
