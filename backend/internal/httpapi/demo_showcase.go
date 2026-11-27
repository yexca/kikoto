package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const demoShowcaseRunReason = workflow.DemoShowcaseTriggerReason

// These are the definitions shown as tabs on the Workflows page. The sample
// history uses their real graphs but never queues a job or contacts a source.
var demoShowcaseWorkflowCodes = []string{
	"local_library_scan", "local_media_index", "metadata_sync",
	"remote_popular_collection", "dlsite_popular_collection", "availability_watch",
	"remote_work_fetch", sourcePresenceCheckWorkflowCode, "circle_catalog_sync", "series_catalog_sync", "voice_catalog_sync",
	aiTranslationWorkflowCode, workFolderEditWorkflowCode,
}

// These examples act on the instance rather than on one work.
var demoShowcaseInstanceWorkflowCodes = []string{
	creatorSubscriptionWorkflowCode, databaseBackupWorkflowCode, databaseOptimizeWorkflowCode,
}

// demoShowcaseLazyWorkflowSpecs are the definitions a workflow registers only
// when its first run is queued. Demo queues none, so the showcase registers
// them before it adds their examples.
func demoShowcaseLazyWorkflowSpecs() []systemWorkflowSpec {
	return []systemWorkflowSpec{
		aiTranslationWorkflowSpec(), workFolderEditDefinition(), databaseBackupWorkflowSpec(), databaseOptimizeWorkflowSpec(),
	}
}

// These Record definitions join the sample history while Demo's generated
// Record library is on, the only time Workflows shows their cards.
var demoShowcaseRecordWorkflowCodes = []string{recordScanWorkflowCode, recordProbeWorkflowCode}

// These extra examples populate Activity's active and attention views without
// dispatching work. Demo never starts the workflow job runner.
var demoShowcaseActivityExamples = []struct {
	code   string
	status string
	error  string
}{
	{code: "local_media_index", status: "running"},
	{code: "metadata_sync", status: "partial", error: "Example: one item needs review."},
	{code: "remote_popular_collection", status: "failed", error: "Example: the source did not respond."},
	{code: "remote_work_fetch", status: "failed", error: "Example: the requested item was unavailable."},
}

type demoShowcaseWork struct {
	id   int64
	code string
}

// SeedDemoShowcase refreshes only synthetic Demo presentation state after the
// real admission scan. The scan's records remain available for private diagnosis.
func (s *Server) SeedDemoShowcase(ctx context.Context) error {
	if !s.cfg.IsDemo() {
		return fmt.Errorf("demo showcase is only available in demo mode")
	}
	recordOn := s.recordLibraryEnabled(ctx)
	demo, err := s.accountStore.LoadByUsername(ctx, account.DemoUsername)
	if err != nil {
		return fmt.Errorf("find demo account: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	works, err := s.seedDemoRemoteSource(ctx, tx)
	if err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM workflow_run WHERE trigger_reason = ?", demoShowcaseRunReason); err != nil {
		return err
	}
	for _, spec := range demoShowcaseLazyWorkflowSpecs() {
		if _, err := workflow.EnsureDefinition(ctx, tx, spec.Code, spec.Name, spec.Description, map[string]any{"nodes": spec.Nodes}); err != nil {
			return err
		}
	}
	// The Fetch and subscription examples also reach the Demo account's Updates.
	notifications := []workflow.NotificationSpec{}
	for _, code := range demoShowcaseWorkflowCodes {
		runID, err := seedDemoWorkflowRun(ctx, tx, code, "succeeded", "", works)
		if err != nil {
			return err
		}
		if code == "remote_work_fetch" && len(works) > 0 {
			notifications = append(notifications, demoFetchNotification(demo.ID, runID, "succeeded", works[0]))
		}
	}
	for _, code := range demoShowcaseInstanceWorkflowCodes {
		runID, err := seedDemoWorkflowRun(ctx, tx, code, "succeeded", "", nil)
		if err != nil {
			return err
		}
		if code == creatorSubscriptionWorkflowCode && len(demoReleaseFeedEntries) > 0 {
			notifications = append(notifications, workflow.NotificationSpec{
				UserID: demo.ID, RunID: runID, Type: "subscription_release", Status: "succeeded",
				WorkCode: demoReleaseFeedEntries[0].code, Message: demoReleaseFeedEntries[0].code + " is new from your subscriptions.",
			})
		}
	}
	if recordOn {
		// Record runs name no work.
		for _, code := range demoShowcaseRecordWorkflowCodes {
			if _, err := seedDemoWorkflowRun(ctx, tx, code, "succeeded", "", nil); err != nil {
				return err
			}
		}
	}
	for _, example := range demoShowcaseActivityExamples {
		runID, err := seedDemoWorkflowRun(ctx, tx, example.code, example.status, example.error, works)
		if err != nil {
			return err
		}
		if example.code == "remote_work_fetch" && len(works) > 0 {
			notifications = append(notifications, demoFetchNotification(demo.ID, runID, example.status, works[0]))
		}
	}
	for _, notification := range notifications {
		if err := workflow.InsertNotification(ctx, tx, notification); err != nil {
			return err
		}
	}
	if err := seedDemoFavorites(ctx, tx); err != nil {
		return err
	}
	// After the favorites, which reset the account's work state the ratings join.
	if err := seedDemoListening(ctx, tx, time.Now()); err != nil {
		return err
	}
	return tx.Commit()
}

// demoFetchNotification is the Updates entry of an example Fetch.
func demoFetchNotification(userID, runID int64, status string, work demoShowcaseWork) workflow.NotificationSpec {
	message := "Fetch completed for " + work.code + "."
	if status == "failed" {
		message = "Fetch failed for " + work.code + "."
	}
	return workflow.NotificationSpec{
		UserID: userID, RunID: runID, Type: "remote_fetch", Status: status,
		WorkID: work.id, WorkCode: work.code, Message: message,
	}
}

// seedDemoWorkflowRun adds one example run and returns its id.
func seedDemoWorkflowRun(ctx context.Context, tx *sql.Tx, code, status, exampleError string, works []demoShowcaseWork) (int64, error) {
	var definitionID int64
	var displayName, definitionJSON string
	if err := tx.QueryRowContext(ctx, `SELECT id, display_name, definition_json
		FROM workflow_definition WHERE code = ?`, code).Scan(&definitionID, &displayName, &definitionJSON); err != nil {
		return 0, err
	}
	var definition struct {
		Nodes []struct {
			ID          string `json:"id"`
			Type        string `json:"type"`
			DisplayName string `json:"displayName"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(definitionJSON), &definition); err != nil {
		return 0, err
	}
	input := map[string]any{"demoShowcase": true}
	if len(works) > 0 {
		input["workCode"] = works[0].code
	}
	runName := "Example: " + displayName
	if status != "succeeded" {
		runName += " (" + status + ")"
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, code, runName,
		status, "manual", demoShowcaseRunReason, input,
		map[string]any{"demoShowcase": true, "message": "Illustrative status; no workflow was executed."})
	if err != nil {
		return 0, err
	}
	var lastNodeID int64
	for index, node := range definition.Nodes {
		name := node.DisplayName
		if name == "" {
			name = node.ID
		}
		nodeStatus := "succeeded"
		nodeError := ""
		if index == len(definition.Nodes)-1 && status != "succeeded" {
			nodeStatus = status
			if status == "partial" {
				nodeStatus = "failed"
			}
			nodeError = exampleError
		}
		var output any = map[string]any{"demoShowcase": true, "message": "Example step completed."}
		if nodeStatus != "succeeded" {
			output = nil
		}
		lastNodeID, err = workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
			NodeID: node.ID, NodeType: node.Type, DisplayName: name,
			Position: index + 1, Status: nodeStatus, Error: nodeError,
			Input:  map[string]any{"demoShowcase": true},
			Output: output,
		})
		if err != nil {
			return 0, err
		}
	}
	jobStatus := status
	if status == "partial" {
		jobStatus = "failed"
	}
	progress := len(definition.Nodes)
	if status != "succeeded" && progress > 0 {
		progress--
	}
	_, err = workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: lastNodeID, WorkerType: "demo_showcase", Status: jobStatus,
		Payload: input, ProgressCurrent: progress, ProgressTotal: len(definition.Nodes), Error: exampleError,
	})
	if err != nil {
		return 0, err
	}
	return runID, nil
}
