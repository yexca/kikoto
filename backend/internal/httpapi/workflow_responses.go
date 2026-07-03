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
	JobCount           int64  `json:"jobCount"`
	CompletedJobs      int64  `json:"completedJobs"`
	FailedJobs         int64  `json:"failedJobs"`
	CandidateCount     int64  `json:"candidateCount"`
	AcceptedCandidates int64  `json:"acceptedCandidates"`
	RejectedCandidates int64  `json:"rejectedCandidates"`
	DefinitionID       *int64 `json:"definitionId"`
	TriggerID          *int64 `json:"triggerId"`
}

type workflowDefinitionRecord struct {
	ID             int64  `json:"id"`
	Code           string `json:"code"`
	DisplayName    string `json:"displayName"`
	Description    string `json:"description"`
	DefinitionJSON string `json:"definitionJson"`
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
