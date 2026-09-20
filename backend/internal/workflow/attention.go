package workflow

import "strconv"

// These correlated projections describe current issues without rewriting run
// results. The success-attempt boundary matches metasync.IssueStore.ForRun:
// a later failure must not reopen an already resolved historical association.
const pendingMetadataSQL = `(SELECT COUNT(DISTINCT tried.work_id)
 FROM metadata_sync_attempt_run AS linked
 JOIN metadata_sync_attempt_work AS tried ON tried.attempt_id = linked.attempt_id
 JOIN work_metadata_sync_state AS state ON state.work_id = tried.work_id
   AND state.provider_id = tried.provider_id AND state.component = tried.component
 WHERE linked.workflow_run_id = run.id AND tried.status != 'succeeded'
   AND state.status IN ('failed', 'unavailable') AND state.last_success_attempt_id <= tried.attempt_id)`

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
	return `(NOT (` + runningRunCondition + `) AND (` + pendingCandidateSQL + ` OR ` + pendingMetadataSQL + ` > 0
   OR (run.status = 'failed' AND NOT ` + reviewed + ` AND NOT ` + resolvedMetadata + `)))`
}

func historyRunCondition(viewerUserID int64) string {
	return `(NOT (` + runningRunCondition + `) AND NOT ` + attentionRunCondition(viewerUserID) + `)`
}
