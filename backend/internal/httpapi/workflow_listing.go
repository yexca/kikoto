package httpapi

import (
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

func (s *Server) listWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	page, err := s.workflowStore.ListRuns(r.Context(), workflow.ListRunsOptions{
		Page: queryInt(r, "page", 1), PageSize: queryInt(r, "pageSize", 25),
		View: strings.TrimSpace(r.URL.Query().Get("view")), Status: strings.TrimSpace(r.URL.Query().Get("status")),
		WorkflowCode: strings.TrimSpace(r.URL.Query().Get("workflowCode")), Query: strings.TrimSpace(r.URL.Query().Get("q")),
		ViewerUserID: actor.ID, CanViewAll: canViewAllWorkflowRuns(actor),
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) listWorkflowDefinitions(w http.ResponseWriter, r *http.Request) {
	_, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	definitions, err := s.workflowStore.ListDefinitions(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	visible := definitions[:0]
	for _, definition := range definitions {
		if definition.Code == "remote_work_save" {
			continue
		}
		visible = append(visible, definition)
	}
	writeJSON(w, http.StatusOK, visible)
}

func (s *Server) listWorkflowTriggers(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	triggers, err := s.workflowStore.ListTriggers(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	definitions, err := s.workflowStore.ListDefinitions(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	visibleDefinitionIDs := make(map[int64]bool, len(definitions))
	for _, definition := range definitions {
		if canUseWorkflowDefinition(actor, definition) {
			visibleDefinitionIDs[definition.ID] = true
		}
	}
	visible := triggers[:0]
	for _, trigger := range triggers {
		if visibleDefinitionIDs[trigger.WorkflowDefinitionID] {
			visible = append(visible, trigger)
		}
	}
	writeJSON(w, http.StatusOK, visible)
}
