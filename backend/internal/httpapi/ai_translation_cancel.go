package httpapi

import "net/http"

func canCancelAITranslationRun(actor currentUser, ownership workflowRunOwnership, status string) bool {
	return canUseTranslationCenter(actor) && (status == "queued" || status == "running") &&
		(ownership.startedBy(actor) || canViewAllWorkflowRuns(actor) || canAdministerWorkflowRuns(actor))
}

// cancelAITranslationRun lets a translator stop their own run without access
// to the workflow administration surface. Run ownership and settlement follow
// the same rules as workflow cancellation.
func (s *Server) cancelAITranslationRun(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, http.StatusForbidden, "llm_disabled", "Translation is unavailable in Demo.", false)
		return
	}
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	s.cancelWorkflowRunForActor(w, r, actor, aiTranslationWorkflowCode)
}
