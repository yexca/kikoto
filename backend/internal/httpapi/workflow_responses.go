package httpapi

import "github.com/yexca/kikoto/backend/internal/workflow"

type workflowRunRecord = workflow.RunRecord
type workflowRunsPageRecord = workflow.RunsPage
type workflowNodeRunRecord = workflow.NodeRunRecord
type workflowEventRecord = workflow.EventRecord
type workflowCandidateRecord = workflow.CandidateRecord
type workflowRunDetailRecord = workflow.RunDetail
type workflowDefinitionRecord = workflow.DefinitionRecord
type workflowTriggerRecord = workflow.TriggerRecord

type workflowRunActionResult struct {
	RunID     int64  `json:"runId"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	NewRunID  *int64 `json:"newRunId,omitempty"`
	Recovered int64  `json:"recovered,omitempty"`
	Requeued  int64  `json:"requeued,omitempty"`
	Failed    int64  `json:"failed,omitempty"`
	Active    int64  `json:"active,omitempty"`
}

type localCandidateCleanupResult struct {
	RunID       int64    `json:"runId"`
	CandidateID int64    `json:"candidateId"`
	Action      string   `json:"action"`
	Status      string   `json:"status"`
	Deleted     int      `json:"deleted"`
	Marked      int      `json:"marked"`
	Failed      int      `json:"failed"`
	Failures    []string `json:"failures"`
}
