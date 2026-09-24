package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Circle and voice actor detail refreshes queue their follow preset with the
// new-works step off. A detail refresh and a Workflows run therefore share one
// pipeline, one run history, and one set of node executors.

// creatorRefreshRequest is the detail-page refresh body shared by circles and
// voice actors. SourceCheck applies to circles only.
type creatorRefreshRequest struct {
	CatalogRefresh  string `json:"catalogRefresh"`
	MetadataRefresh string `json:"metadataRefresh"`
	SourceCheck     bool   `json:"sourceCheck"`
}

func (request creatorRefreshRequest) normalized() creatorRefreshRequest {
	switch request.CatalogRefresh = strings.ToLower(strings.TrimSpace(request.CatalogRefresh)); request.CatalogRefresh {
	case "stored", "incremental", "full":
	default:
		request.CatalogRefresh = "incremental"
	}
	switch request.MetadataRefresh = strings.ToLower(strings.TrimSpace(request.MetadataRefresh)); request.MetadataRefresh {
	case "off", "missing", "all":
	default:
		request.MetadataRefresh = "missing"
	}
	return request
}

// creatorRefreshRun is the public view of the newest follow run for a circle
// or voice actor.
type creatorRefreshRun struct {
	RunID        int64  `json:"runId"`
	Status       string `json:"status"`
	Deduplicated bool   `json:"deduplicated,omitempty"`
	inputsJSON   string
}

type creatorRefreshError struct {
	status  int
	message string
}

func (e creatorRefreshError) Error() string { return e.message }

var errCreatorRefreshInProgress = creatorRefreshError{status: http.StatusConflict, message: "a different refresh is already running"}

// queueCreatorRefresh plans a follow preset for one detail refresh. An active
// run with the same inputs is reused; a different active run is a conflict.
func (s *Server) queueCreatorRefresh(ctx context.Context, actor currentUser, code string, inputs map[string]any, active func(context.Context) (creatorRefreshRun, bool, error)) (creatorRefreshRun, error) {
	spec, found := presetWorkflowSpecByCode(code)
	if !found {
		return creatorRefreshRun{}, errors.New("workflow preset not found")
	}
	plan, err := s.planPresetWorkflow(ctx, spec, inputs, time.Now(), false)
	if err != nil {
		return creatorRefreshRun{}, creatorRefreshError{status: http.StatusBadRequest, message: err.Error()}
	}
	if plan.Inputs.NewWorks {
		return creatorRefreshRun{}, errors.New("a detail refresh must not follow new works")
	}
	// A detail refresh is authorized by metadata:sync, as before the merge. Its
	// graph holds only refresh steps, so the run carries workflows:run on the
	// viewer's behalf and every step still checks its own permission.
	permissions := uniqueStrings(append(append([]string{}, actor.Permissions...), "workflows:run"))
	if missing := missingWorkflowGraphPermission(permissions, workflowGraphRequiredPermissions(plan.Graph)); missing != "" {
		return creatorRefreshRun{}, creatorRefreshError{status: http.StatusForbidden, message: "permission denied"}
	}
	s.creatorRefreshMu.Lock()
	defer s.creatorRefreshMu.Unlock()
	public := plan.Inputs.public()
	if run, ok, err := active(ctx); err != nil {
		return creatorRefreshRun{}, err
	} else if ok {
		if sameWorkflowInputs(run.inputsJSON, public) {
			run.Deduplicated = true
			return run, nil
		}
		return creatorRefreshRun{}, errCreatorRefreshInProgress
	}
	definition, err := s.loadWorkflowDefinitionByCode(ctx, code)
	if err != nil {
		return creatorRefreshRun{}, err
	}
	runID, err := s.enqueueWorkflowGraph(ctx, definition, plan.Graph, actor.ID, permissions, public, workflowGraphEnqueueOptions{
		TriggerType: "manual", TriggerReason: "detail_refresh", DefinitionJSON: plan.DefinitionJSON,
	})
	if err != nil {
		return creatorRefreshRun{}, err
	}
	return creatorRefreshRun{RunID: runID, Status: "queued"}, nil
}

// writeCreatorRefreshError writes a failed queue attempt and reports whether
// the caller may continue.
func (s *Server) writeCreatorRefreshError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return true
	}
	var refreshErr creatorRefreshError
	if errors.As(err, &refreshErr) {
		writeJSON(w, refreshErr.status, map[string]string{"error": refreshErr.message})
		return false
	}
	writeError(w, err)
	return false
}

func sameWorkflowInputs(storedJSON string, inputs map[string]any) bool {
	var stored map[string]any
	if json.Unmarshal([]byte(storedJSON), &stored) != nil {
		return false
	}
	return mustJSON(stored) == mustJSON(inputs)
}

// compatibleRemoteSourceIDs lists the enabled sources a detail refresh uses
// when the viewer does not choose sources.
func (s *Server) compatibleRemoteSourceIDs(ctx context.Context) ([]int64, error) {
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	for _, source := range sources {
		if source.Enabled && isKikoeruSourceType(source.SourceType) && strings.TrimSpace(source.Endpoint.APIURL) != "" {
			ids = append(ids, source.ID)
		}
	}
	return ids, nil
}

func (s *Server) latestCircleFollowRun(ctx context.Context, circleID string, activeOnly bool) (creatorRefreshRun, bool, error) {
	return s.latestCreatorFollowRun(ctx, `
		workflow_code = 'circle_follow'
		AND (',' || REPLACE(UPPER(COALESCE(json_extract(input_json, '$.inputs.circleId'), '')), ' ', '') || ',') LIKE '%,' || ? || ',%'
	`, normalizeMakerID(circleID), activeOnly)
}

func (s *Server) latestVoiceFollowRun(ctx context.Context, personID int64, activeOnly bool) (creatorRefreshRun, bool, error) {
	return s.latestCreatorFollowRun(ctx, `
		workflow_code = 'voice_follow'
		AND CAST(json_extract(input_json, '$.inputs.personId') AS INTEGER) = ?
	`, personID, activeOnly)
}

func (s *Server) latestCreatorFollowRun(ctx context.Context, condition string, target any, activeOnly bool) (creatorRefreshRun, bool, error) {
	if activeOnly {
		condition += " AND status IN ('queued', 'running')"
	}
	var run creatorRefreshRun
	err := s.db.QueryRowContext(ctx, `
		SELECT id, status, COALESCE(json_extract(input_json, '$.inputs'), '{}')
		FROM workflow_run
		WHERE `+condition+`
		ORDER BY id DESC
		LIMIT 1
	`, target).Scan(&run.RunID, &run.Status, &run.inputsJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return creatorRefreshRun{}, false, nil
	}
	if err != nil {
		return creatorRefreshRun{}, false, err
	}
	return run, true, nil
}
