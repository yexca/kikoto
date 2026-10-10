package httpapi

// Shared workflow request and cleanup payload types.

type workflowTriggerPayload struct {
	WorkflowDefinitionID int64   `json:"workflowDefinitionId"`
	DisplayName          string  `json:"displayName"`
	TriggerType          string  `json:"triggerType"`
	Enabled              *bool   `json:"enabled"`
	ScheduleJSON         string  `json:"scheduleJson"`
	ConfigJSON           string  `json:"configJson"`
	NextRunAt            *string `json:"nextRunAt"`
}

type workflowCandidateUpdatePayload struct {
	Status       string `json:"status"`
	DecisionJSON string `json:"decisionJson"`
}

type localCandidateCleanupPayload struct {
	Action      string  `json:"action"`
	LocationIDs []int64 `json:"locationIds"`
}

type localLocationCleanupJobPayload struct {
	CandidateID int64   `json:"candidate_id"`
	Action      string  `json:"action"`
	LocationIDs []int64 `json:"location_ids"`
}

type localLocationCleanupCheckpoint struct {
	CompletedLocationIDs []int64                     `json:"completedLocationIds"`
	Result               localCandidateCleanupResult `json:"result"`
}

// ensureSystemWorkflowDefinitions synchronizes workflow metadata only. It
