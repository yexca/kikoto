package workflow

import "strconv"

// PendingMetadataState is the trusted condition under which a
// work_metadata_sync_state row aliased as state still needs recovery. A
// product a provider reports as not found is settled once a remote source has
// filled the work, because the work's metadata is then complete, or once an
// operator has dismissed it, for example because the product was delisted.
const PendingMetadataState = `(state.status = 'failed' OR (state.status = 'unavailable' AND state.dismissed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM work_metadata_field_source AS filled WHERE filled.work_id = state.work_id)))`

// These correlated projections describe current issues without rewriting run
// results. The success-attempt boundary matches metasync.IssueStore.ForRun:
// a later failure must not reopen an already resolved historical association.
func pendingRunMetadataSQL(stateCondition string) string {
	return `(SELECT COUNT(DISTINCT tried.work_id)
 FROM metadata_sync_attempt_run AS linked
 JOIN metadata_sync_attempt_work AS tried ON tried.attempt_id = linked.attempt_id
 JOIN work_metadata_sync_state AS state ON state.work_id = tried.work_id
   AND state.provider_id = tried.provider_id AND state.component = tried.component
 WHERE linked.workflow_run_id = run.id AND tried.status != 'succeeded'
   AND ` + stateCondition + ` AND state.last_success_attempt_id <= tried.attempt_id)`
}

var (
	pendingMetadataSQL = pendingRunMetadataSQL(PendingMetadataState)
	// A pending failure can be retried; the other pending issues are products
	// a provider reports as not found, which a user may acknowledge instead.
	pendingFailedMetadataSQL = pendingRunMetadataSQL(`state.status = 'failed'`)
)

const encounteredMetadataSQL = `EXISTS (SELECT 1 FROM metadata_sync_attempt_run AS linked
 JOIN metadata_sync_attempt_work AS tried ON tried.attempt_id = linked.attempt_id
 WHERE linked.workflow_run_id = run.id AND tried.status != 'succeeded')`

const pendingCandidateSQL = `EXISTS (SELECT 1 FROM workflow_candidate AS candidate
 WHERE candidate.workflow_run_id = run.id AND candidate.status NOT IN ('accepted', 'rejected', 'ignored', 'resolved'))`

func attentionRunCondition(viewerUserID int64) string {
	// Reviews belong to the viewer, including when an administrator can see all runs.
	reviewed := `EXISTS (SELECT 1 FROM workflow_run_review AS review WHERE review.workflow_run_id = run.id
   AND review.status = 'reviewed' AND review.user_id = ` + strconv.FormatInt(viewerUserID, 10) + `)`
	// Automatic resolution is limited to dedicated metadata runs with recorded
	// issue outcomes. Other failures require their own recovery or acknowledgement.
	resolvedMetadata := `(run.workflow_code IN ('metadata_sync', 'metadata_family_sync') AND ` + encounteredMetadataSQL + ` AND ` + pendingMetadataSQL + ` = 0)`
	// A viewer's review covers pending not-found products, never retryable failures.
	return `(NOT (` + runningRunCondition + `) AND (` + pendingCandidateSQL + ` OR ` + pendingFailedMetadataSQL + ` > 0
	   OR (` + pendingMetadataSQL + ` > 0 AND NOT ` + reviewed + `)
	   OR (run.status IN ('failed', 'partial') AND NOT ` + reviewed + ` AND NOT ` + resolvedMetadata + `)))`
}

func historyRunCondition(viewerUserID int64) string {
	return `(NOT (` + runningRunCondition + `) AND NOT ` + attentionRunCondition(viewerUserID) + `)`
}
