package workflow

type RunRecord struct {
	ID                 int64  `json:"id"`
	WorkflowCode       string `json:"workflowCode"`
	DisplayName        string `json:"displayName"`
	Status             string `json:"status"`
	TriggerType        string `json:"triggerType"`
	TriggerReason      string `json:"triggerReason"`
	CreatedAt          string `json:"createdAt"`
	StartedAt          string `json:"startedAt"`
	FinishedAt         string `json:"finishedAt"`
	SummaryJSON        string `json:"summaryJson"`
	NodeRunCount       int64  `json:"nodeRunCount"`
	CompletedNodeRuns  int64  `json:"completedNodeRuns"`
	FailedNodeRuns     int64  `json:"failedNodeRuns"`
	SkippedNodeRuns    int64  `json:"skippedNodeRuns"`
	JobCount           int64  `json:"jobCount"`
	CompletedJobs      int64  `json:"completedJobs"`
	FailedJobs         int64  `json:"failedJobs"`
	SkippedJobs        int64  `json:"skippedJobs"`
	CandidateCount     int64  `json:"candidateCount"`
	PendingCandidates  int64  `json:"pendingCandidates"`
	AcceptedCandidates int64  `json:"acceptedCandidates"`
	RejectedCandidates int64  `json:"rejectedCandidates"`
	ReviewedAt         string `json:"reviewedAt"`
	ReviewedByUserID   *int64 `json:"reviewedByUserId"`
	DefinitionID       *int64 `json:"definitionId"`
	TriggerID          *int64 `json:"triggerId"`
}

type RunsPage struct {
	Runs     []RunRecord `json:"runs"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
	Total    int64       `json:"total"`
}

type NodeRunRecord struct {
	ID           int64  `json:"id"`
	NodeID       string `json:"nodeId"`
	NodeType     string `json:"nodeType"`
	DisplayName  string `json:"displayName"`
	Position     int64  `json:"position"`
	Status       string `json:"status"`
	InputJSON    string `json:"inputJson"`
	OutputJSON   string `json:"outputJson"`
	ErrorMessage string `json:"errorMessage"`
	StartedAt    string `json:"startedAt"`
	FinishedAt   string `json:"finishedAt"`
	CreatedAt    string `json:"createdAt"`
}

type EventRecord struct {
	ID         int64  `json:"id"`
	RunID      int64  `json:"runId"`
	NodeRunID  *int64 `json:"nodeRunId"`
	JobID      *int64 `json:"jobId"`
	Level      string `json:"level"`
	EventType  string `json:"eventType"`
	Message    string `json:"message"`
	DetailJSON string `json:"detailJson"`
	CreatedAt  string `json:"createdAt"`
}

type CandidateRecord struct {
	ID           int64  `json:"id"`
	RunID        int64  `json:"runId"`
	NodeRunID    *int64 `json:"nodeRunId"`
	Type         string `json:"type"`
	ExternalKey  string `json:"externalKey"`
	Status       string `json:"status"`
	PayloadJSON  string `json:"payloadJson"`
	DecisionJSON string `json:"decisionJson"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}

type RunDetail struct {
	RunRecord
	NodeRuns  []NodeRunRecord `json:"nodeRuns"`
	GraphJSON string          `json:"graphJson"`
}

type DefinitionRecord struct {
	ID             int64  `json:"id"`
	Code           string `json:"code"`
	DisplayName    string `json:"displayName"`
	Description    string `json:"description"`
	DefinitionJSON string `json:"definitionJson"`
	Scope          string `json:"scope"`
	Editable       bool   `json:"editable"`
	OwnerUserID    *int64 `json:"ownerUserId"`
	TriggerCount   int64  `json:"triggerCount"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

type TriggerRecord struct {
	ID                   int64   `json:"id"`
	WorkflowDefinitionID int64   `json:"workflowDefinitionId"`
	WorkflowCode         string  `json:"workflowCode"`
	DisplayName          string  `json:"displayName"`
	TriggerType          string  `json:"triggerType"`
	Enabled              bool    `json:"enabled"`
	ScheduleJSON         string  `json:"scheduleJson"`
	ConfigJSON           string  `json:"configJson"`
	NextRunAt            *string `json:"nextRunAt"`
	LastRunAt            *string `json:"lastRunAt"`
	LastSuccessAt        *string `json:"lastSuccessAt"`
	LastErrorMessage     string  `json:"lastErrorMessage"`
	CreatedAt            string  `json:"createdAt"`
	UpdatedAt            string  `json:"updatedAt"`
}
