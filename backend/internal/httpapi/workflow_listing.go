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
		DemoShowcase: s.cfg.IsDemo(),
	})
	if err != nil {
		writeError(w, err)
		return
	}
	s.remoteAddressRedactorFor(r.Context()).runs(page.Runs)
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

// maxWorkflowStatusCodes bounds how many workflows one status request names.
const maxWorkflowStatusCodes = 50

// listWorkflowStatuses answers where each system workflow stands: its latest
// and current run, how many runs are active, whether it needs review, its next
// scheduled run, and its stage count. The answer comes from every run the
// viewer may see, so it does not depend on how many runs are active.
func (s *Server) listWorkflowStatuses(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	codes := []string{}
	for _, code := range r.URL.Query()["code"] {
		if code = strings.TrimSpace(code); code != "" {
			codes = append(codes, code)
		}
	}
	if len(codes) > maxWorkflowStatusCodes {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "too many workflow codes", false)
		return
	}
	statuses, err := s.workflowStore.ListDefinitionStatuses(r.Context(), workflow.StatusOptions{
		Codes: codes, ViewerUserID: actor.ID, CanViewAll: canViewAllWorkflowRuns(actor), DemoShowcase: s.cfg.IsDemo(),
	})
	if err != nil {
		writeError(w, err)
		return
	}
	visible := statuses[:0]
	redactor := s.remoteAddressRedactorFor(r.Context())
	for _, status := range statuses {
		if status.Code == "remote_work_save" {
			continue
		}
		redactor.run(status.LatestRun)
		redactor.run(status.CurrentRun)
		visible = append(visible, status)
	}
	writeJSON(w, http.StatusOK, map[string]any{"workflows": visible})
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
	s.remoteAddressRedactorFor(r.Context()).triggers(visible)
	writeJSON(w, http.StatusOK, visible)
}
