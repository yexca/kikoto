package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"sort"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const demoShowcaseSourceCode = "demo_showcase"
const demoShowcaseRunReason = workflow.DemoShowcaseTriggerReason

// These are the definitions shown as tabs on the Workflows page. The sample
// history uses their real graphs but never queues a job or contacts a source.
var demoShowcaseWorkflowCodes = []string{
	"local_library_scan", "local_media_index", "metadata_sync",
	"remote_popular_collection", "dlsite_popular_collection", "availability_watch",
	"remote_work_fetch", "circle_follow", "series_follow", "voice_follow",
}

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
	hash uint64
}

// SeedDemoShowcase refreshes only synthetic Demo presentation state after the
// real admission scan. The scan's records remain available for private diagnosis.
func (s *Server) SeedDemoShowcase(ctx context.Context) error {
	if !s.cfg.IsDemo() {
		return fmt.Errorf("demo showcase is only available in demo mode")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO file_source (code, display_name, source_type, enabled)
		VALUES (?, 'Example Track (Demo)', 'demo_showcase', 0)
		ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name,
			source_type = excluded.source_type, enabled = 0
	`, demoShowcaseSourceCode); err != nil {
		return err
	}
	var sourceID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM file_source WHERE code = ?", demoShowcaseSourceCode).Scan(&sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_source_presence WHERE file_source_id = ?", sourceID); err != nil {
		return err
	}

	works, err := demoShowcaseEligibleWorks(ctx, tx)
	if err != nil {
		return err
	}
	for _, work := range works {
		if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
			WorkID: work.id, FileSourceID: sourceID, PresenceType: "tracked",
			RemoteCode: work.code, Availability: "available",
			RawJSON: `{"demoShowcase":true}`,
		}); err != nil {
			return err
		}
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM workflow_run WHERE trigger_reason = ?", demoShowcaseRunReason); err != nil {
		return err
	}
	for _, code := range demoShowcaseWorkflowCodes {
		if err := seedDemoWorkflowRun(ctx, tx, code, "succeeded", "", works); err != nil {
			return err
		}
	}
	for _, example := range demoShowcaseActivityExamples {
		if err := seedDemoWorkflowRun(ctx, tx, example.code, example.status, example.error, works); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func demoShowcaseEligibleWorks(ctx context.Context, tx *sql.Tx) ([]demoShowcaseWork, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT work.id, work.primary_code FROM work
		WHERE `+contentpolicy.DemoEligibleWorkSQL("work")+`
			AND EXISTS (SELECT 1 FROM work_source_presence AS presence
				INNER JOIN file_source AS source ON source.id = presence.file_source_id
				WHERE presence.work_id = work.id AND presence.presence_type = 'local'
					AND presence.availability = 'available' AND source.source_type = 'local_folder')
		ORDER BY work.primary_code
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	works := []demoShowcaseWork{}
	for rows.Next() {
		var work demoShowcaseWork
		if err := rows.Scan(&work.id, &work.code); err != nil {
			return nil, err
		}
		h := fnv.New64a()
		_, _ = h.Write([]byte(work.code))
		work.hash = h.Sum64()
		works = append(works, work)
		if len(works) > 4 {
			sort.Slice(works, func(i, j int) bool {
				if works[i].hash == works[j].hash {
					return works[i].code < works[j].code
				}
				return works[i].hash < works[j].hash
			})
			works = works[:4]
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(works, func(i, j int) bool {
		if works[i].hash == works[j].hash {
			return works[i].code < works[j].code
		}
		return works[i].hash < works[j].hash
	})
	return works, nil
}

func seedDemoWorkflowRun(ctx context.Context, tx *sql.Tx, code, status, exampleError string, works []demoShowcaseWork) error {
	var definitionID int64
	var displayName, definitionJSON string
	if err := tx.QueryRowContext(ctx, `SELECT id, display_name, definition_json
		FROM workflow_definition WHERE code = ?`, code).Scan(&definitionID, &displayName, &definitionJSON); err != nil {
		return err
	}
	var definition struct {
		Nodes []struct {
			ID          string `json:"id"`
			Type        string `json:"type"`
			DisplayName string `json:"displayName"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(definitionJSON), &definition); err != nil {
		return err
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
		return err
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
			return err
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
		return err
	}
	return nil
}
