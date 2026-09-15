package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/metasync"
)

func (s *Server) listMetadataIssues(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	query := metasync.IssueQuery{Page: 1, PageSize: 25, Search: strings.TrimSpace(r.URL.Query().Get("q")), Status: r.URL.Query().Get("status")}
	if value := r.URL.Query().Get("page"); value != "" {
		page, err := strconv.Atoi(value)
		if err != nil || page < 1 || page > 1000000 {
			writeAPIError(w, http.StatusBadRequest, "invalid_page", "invalid page", false)
			return
		}
		query.Page = page
	}
	if len(query.Search) > 256 || (query.Status != "" && query.Status != "failed" && query.Status != "unavailable") {
		writeAPIError(w, http.StatusBadRequest, "invalid_filter", "invalid metadata issue filter", false)
		return
	}
	if value := r.URL.Query().Get("runId"); value != "" {
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || id <= 0 {
			writeAPIError(w, http.StatusBadRequest, "invalid_run", "invalid workflow run", false)
			return
		}
		if !userHasPermission(actor, "workflows:run") {
			writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
			return
		}
		if !s.requireWorkflowRunAccess(w, r, actor, id) {
			return
		}
		query.RunID = id
	}
	page, err := metasync.NewIssueStore(s.db).List(r.Context(), query)
	if err != nil {
		writeError(w, err)
		return
	}
	for index := range page.Items {
		page.Items[index].Retrying = page.Items[index].Retrying || s.metadataCoordinator.IsRunning(page.Items[index].FamilyCode)
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) retryMetadataIssues(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, http.StatusForbidden, "demo_read_only", "demo is read only", false)
		return
	}
	var payload struct {
		WorkIDs []int64 `json:"workIds"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid metadata retry request", false)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid metadata retry request", false)
		return
	}
	if len(payload.WorkIDs) == 0 || len(payload.WorkIDs) > 100 {
		writeAPIError(w, http.StatusBadRequest, "invalid_selection", "select between 1 and 100 works", false)
		return
	}
	seen := map[int64]bool{}
	for _, id := range payload.WorkIDs {
		if id <= 0 || seen[id] {
			writeAPIError(w, http.StatusBadRequest, "invalid_selection", "invalid work selection", false)
			return
		}
		seen[id] = true
	}
	result := struct {
		Queued  int `json:"queued"`
		Skipped int `json:"skipped"`
		Failed  int `json:"failed"`
	}{}
	store := metasync.NewIssueStore(s.db)
	for _, id := range payload.WorkIDs {
		pending, err := store.HasPendingDLsite(r.Context(), id)
		if err == nil && !pending {
			result.Skipped++
			continue
		}
		if err == nil {
			// Explicit recovery may recheck not_found without clearing that
			// observation first. Only a successful new result changes it.
			_, err = s.enqueueWorkMetadataSyncWithOptions(r.Context(), id, true)
		}
		if err != nil {
			slog.Warn("queue metadata recovery", "work_id", id, "error", err)
			result.Failed++
		} else {
			result.Queued++
		}
	}
	writeJSON(w, http.StatusAccepted, result)
}
