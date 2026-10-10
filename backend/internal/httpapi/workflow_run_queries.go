package httpapi

// Read-only workflow run, event, and candidate queries.

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/metasync"
)

func (s *Server) getWorkflowRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if !s.requireWorkflowRunAccess(w, r, actor, id) {
		return
	}
	detail, err := s.workflowStore.LoadRunDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	graphJSON, err := s.workflowRunGraphJSON(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	detail.GraphJSON = graphJSON
	s.remoteAddressRedactorFor(r.Context()).runDetail(&detail)
	var metadataIssues metasync.RunIssueSummary
	if userHasPermission(actor, "metadata:sync") {
		metadataIssues, err = metasync.NewIssueStore(s.db).ForRun(r.Context(), id)
		if err != nil {
			writeError(w, err)
			return
		}
	}
	canManage, err := canManageWorkflowRun(r.Context(), s.db, actor, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		workflowRunDetailRecord
		MetadataIssues metasync.RunIssueSummary `json:"metadataIssues"`
		// CanManage reports whether this viewer may cancel, retry, or
		// review the run's items: it started the run or administers runs.
		CanManage bool `json:"canManage"`
	}{detail, metadataIssues, canManage})
}

func (s *Server) listWorkflowRunEvents(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if !s.requireWorkflowRunAccess(w, r, actor, id) {
		return
	}
	afterID := int64(0)
	if value := strings.TrimSpace(r.URL.Query().Get("afterId")); value != "" {
		afterID, err = strconv.ParseInt(value, 10, 64)
		if err != nil || afterID < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow event cursor"})
			return
		}
	}
	events, err := s.workflowStore.ListEventsAfter(r.Context(), id, afterID)
	if err != nil {
		writeError(w, err)
		return
	}
	s.remoteAddressRedactorFor(r.Context()).events(events)
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) listWorkflowRunCandidates(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if !s.requireWorkflowRunAccess(w, r, actor, id) {
		return
	}
	candidates, err := s.loadWorkflowCandidates(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	s.remoteAddressRedactorFor(r.Context()).candidates(candidates)
	writeJSON(w, http.StatusOK, candidates)
}

func (s *Server) loadWorkflowCandidates(ctx context.Context, runID int64) ([]workflowCandidateRecord, error) {
	return s.workflowStore.ListCandidates(ctx, runID)
}
