package httpapi

type workflowRunRecord struct {
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
	DefinitionID       *int64 `json:"definitionId"`
	TriggerID          *int64 `json:"triggerId"`
}

type workflowRunsPageRecord struct {
	Runs     []workflowRunRecord `json:"runs"`
	Page     int                 `json:"page"`
	PageSize int                 `json:"pageSize"`
	Total    int64               `json:"total"`
}

type workflowNodeRunRecord struct {
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

type workflowEventRecord struct {
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

type workflowCandidateRecord struct {
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

type workflowRunActionResult struct {
	RunID     int64  `json:"runId"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	NewRunID  *int64 `json:"newRunId,omitempty"`
	Recovered int64  `json:"recovered,omitempty"`
}

type workflowRunDetailRecord struct {
	workflowRunRecord
	NodeRuns []workflowNodeRunRecord `json:"nodeRuns"`
}

type workflowDefinitionRecord struct {
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

type workflowTriggerRecord struct {
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

type workflowNodeTypeRecord struct {
	Type         string `json:"type"`
	Phase        string `json:"phase"`
	DisplayName  string `json:"displayName"`
	Description  string `json:"description"`
	UserVisible  bool   `json:"userVisible"`
	ConfigSchema string `json:"configSchema"`
	InputSchema  string `json:"inputSchema"`
	OutputSchema string `json:"outputSchema"`
}
