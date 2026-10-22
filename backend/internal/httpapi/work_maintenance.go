package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

type maintenanceWork struct {
	libraryWorkSummary
	NoSource bool `json:"noSource"`
	// SourceTier ranks the family's best available source: local, remote, or none.
	SourceTier     string               `json:"sourceTier"`
	MetadataIssues []metasync.IssueWork `json:"metadataIssues"`
	// MetadataNotSynced marks a catalog family DLsite was never asked about;
	// MetadataSyncing marks its sync as queued or running.
	MetadataNotSynced bool `json:"metadataNotSynced"`
	MetadataSyncing   bool `json:"metadataSyncing"`
	// RemoteMetadataSource names the remote source that filled a family
	// without DLsite metadata. Such a family is complete, not an issue.
	RemoteMetadataSource string `json:"remoteMetadataSource,omitempty"`
}

func (s *Server) listWorkMaintenance(w http.ResponseWriter, r *http.Request) {
	actor, ok := userFromContext(r.Context())
	if !ok {
		writeAPIError(w, http.StatusUnauthorized, "login_required", "login required", false)
		return
	}
	// Demo grants read-only previews of maintenance, matching other settings
	// reads; ListMaintenance still applies the demo work eligibility predicate.
	canSources := s.cfg.IsDemo() || userHasPermission(actor, "sources:write")
	canMetadata := s.cfg.IsDemo() || userHasPermission(actor, "metadata:sync")
	if !canSources && !canMetadata {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
		return
	}
	options := library.MaintenanceOptions{ListOptions: library.ListOptions{UserID: actor.ID, Page: 1, PageSize: 25,
		Query: strings.TrimSpace(r.URL.Query().Get("q")), DemoOnly: s.cfg.IsDemo()}, IncludeNoSource: canSources, Reason: r.URL.Query().Get("reason")}
	for key, target := range map[string]*int{"page": &options.Page, "pageSize": &options.PageSize} {
		if value := r.URL.Query().Get(key); value != "" {
			number, err := strconv.Atoi(value)
			if err != nil || number < 1 || number > 1000000 || (key == "pageSize" && number != 25 && number != 50) {
				writeAPIError(w, http.StatusBadRequest, "invalid_page", "invalid page", false)
				return
			}
			*target = number
		}
	}
	if len(options.Query) > 256 || (options.Reason != "" && options.Reason != "all" && options.Reason != "catalog" && options.Reason != "custom" && options.Reason != "metadata" && options.Reason != "no_source") {
		writeAPIError(w, http.StatusBadRequest, "invalid_filter", "invalid maintenance filter", false)
		return
	}
	if (options.Reason == "metadata" && !canMetadata) || (options.Reason == "no_source" && !canSources) {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
		return
	}
	var runID int64
	if value := r.URL.Query().Get("runId"); value != "" {
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || id <= 0 {
			writeAPIError(w, http.StatusBadRequest, "invalid_run", "invalid workflow run", false)
			return
		}
		if !canMetadata || !userHasPermission(actor, "workflows:run") {
			writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
			return
		}
		if !s.requireWorkflowRunAccess(w, r, actor, id) {
			return
		}
		runID, options.Reason = id, "metadata"
	}
	if canMetadata {
		options.MetadataWhere, options.MetadataArgs = metasync.PendingFamilyPredicate(runID)
		// A run filter narrows to that run's issues; otherwise a family DLsite
		// was never asked about also needs metadata attention.
		if runID == 0 {
			options.MetadataWhere = "(" + options.MetadataWhere + ") OR " + metasync.NotSyncedFamilyPredicate()
		}
	}
	page, err := s.libraryStore.ListMaintenance(r.Context(), options)
	if err != nil {
		writeError(w, err)
		return
	}
	works, err := s.scanLibraryWorkRows(r.Context(), actor.ID, page.Works, true)
	if err != nil {
		writeError(w, err)
		return
	}
	ids := make([]int64, len(works))
	for i, work := range works {
		ids[i] = work.ID
	}
	issuesByFamily := map[int64][]metasync.IssueWork{}
	familyStates := map[int64]metasync.FamilyState{}
	if canMetadata {
		store := metasync.NewIssueStore(s.db)
		issues, err := store.ListForFamilies(r.Context(), ids)
		if err != nil {
			writeError(w, err)
			return
		}
		for _, issue := range issues {
			issue.Retrying = issue.Retrying || s.metadataCoordinator.IsRunning(issue.FamilyCode)
			issuesByFamily[issue.FamilyWorkID] = append(issuesByFamily[issue.FamilyWorkID], issue)
		}
		if familyStates, err = store.FamilyStates(r.Context(), ids); err != nil {
			writeError(w, err)
			return
		}
	}
	items := make([]maintenanceWork, 0, len(works))
	for _, work := range works {
		issues := issuesByFamily[work.ID]
		if issues == nil {
			issues = []metasync.IssueWork{}
		}
		state := familyStates[work.ID]
		items = append(items, maintenanceWork{libraryWorkSummary: work, NoSource: page.NoSource[work.ID],
			SourceTier: page.SourceTiers[work.ID], MetadataIssues: issues,
			MetadataNotSynced: state.NotSynced, RemoteMetadataSource: state.RemoteSource,
			MetadataSyncing: state.NotSynced && (state.Syncing || s.metadataCoordinator.IsRunning(state.FamilyCode))})
	}
	writeJSON(w, http.StatusOK, struct {
		Works    []maintenanceWork `json:"works"`
		Total    int               `json:"total"`
		Page     int               `json:"page"`
		PageSize int               `json:"pageSize"`
	}{items, page.Total, page.Page, page.PageSize})
}
