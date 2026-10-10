package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
)

func (s *Server) listVoices(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	summaries, err := s.loadVoiceSummaries(r.Context(), userID)
	if err != nil {
		writeError(w, err)
		return
	}
	tagNames := map[string]bool{}
	for _, summary := range summaries {
		for _, tag := range summary.UserTags {
			tagNames[tag.Name] = true
		}
	}
	tagOptions := make([]string, 0, len(tagNames))
	for name := range tagNames {
		tagOptions = append(tagOptions, name)
	}
	sort.Strings(tagOptions)
	summaries = filterVoiceSummaries(
		summaries,
		strings.TrimSpace(r.URL.Query().Get("q")),
		strings.TrimSpace(r.URL.Query().Get("filter")),
		strings.TrimSpace(r.URL.Query().Get("tag")),
	)
	// Metadata organizes voice actors by Kikoto person id, independent of
	// names or credit counts; browsing keeps the most-credited first.
	if r.URL.Query().Get("sort") == "id" {
		sort.SliceStable(summaries, func(i, j int) bool { return summaries[i].PersonID < summaries[j].PersonID })
	}
	pageSize := queryInt(r, "pageSize", 24)
	page, start, end := creatorPageBounds(queryInt(r, "page", 1), pageSize, len(summaries))
	pageItems := summaries[start:end]
	for index := range pageItems {
		s.presentVoiceLatestWorkCover(r.Context(), pageItems[index].LatestWork)
	}
	writeJSON(w, http.StatusOK, voiceSummaryPage{
		Voices: pageItems, Page: page, PageSize: minInt(pageSize, 100), Total: len(summaries), TagOptions: tagOptions,
	})
}

func (s *Server) getVoice(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	summary, err := s.loadVoiceSummary(r.Context(), userID, personID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	works := []voiceKnownWork{}
	if r.URL.Query().Get("includeWorks") != "false" {
		works, err = s.loadVoiceKnownWorks(r.Context(), userID, personID)
		if err != nil {
			writeError(w, err)
			return
		}
	}
	aliases, err := s.loadVoiceAliases(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	summary.Aliases = aliasNames(aliases)
	missing, err := s.loadVoiceCatalogMetadataTargets(r.Context(), personID, "incremental")
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		voiceDetail
		AliasRecords []voiceAlias `json:"aliasRecords"`
	}{voiceDetail: voiceDetail{
		voiceSummary: summary, Works: works, RemoteMatches: []voiceRemoteSourceSet{}, MetadataMissingWorks: len(missing),
	}, AliasRecords: aliases})
}

func (s *Server) getVoiceWorks(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	works, err := s.loadVoiceKnownWorks(r.Context(), userID, personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"personId": personID, "works": works})
}

func (s *Server) getVoiceRemoteMatches(w http.ResponseWriter, r *http.Request) {
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	state, err := s.currentVoiceCatalogRefreshState(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	matches, err := s.loadVoiceCatalogMatches(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"personId": personID, "remoteMatches": matches, "refresh": state})
}

func (s *Server) listVoiceAliasCandidates(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	candidates, err := s.loadVoiceAliasCandidates(r.Context(), personID, query)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, candidates)
}

func (s *Server) createVoiceAlias(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	var payload struct {
		Alias string `json:"alias"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	alias := strings.TrimSpace(payload.Alias)
	if alias == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "alias is required"})
		return
	}
	if len(alias) > 120 {
		alias = alias[:120]
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO person_alias (person_id, alias, source)
		VALUES (?, ?, 'manual_review')
		ON CONFLICT(person_id, alias) DO NOTHING
	`, personID, alias); err != nil {
		writeError(w, err)
		return
	}
	aliases, err := s.loadVoiceAliases(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, aliases)
}

func (s *Server) deleteVoiceAlias(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	aliasID, err := parseInt64PathValue(r, "aliasId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid alias id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM person_alias WHERE id = ? AND person_id = ? AND source <> 'primary_name'", aliasID, personID)
	if err != nil {
		writeError(w, err)
		return
	}
	deleted, _ := result.RowsAffected()
	aliases, err := s.loadVoiceAliases(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted, "aliases": aliases})
}

func (s *Server) mergeVoiceAliasCandidate(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	targetID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	var payload struct {
		SourcePersonID int64 `json:"sourcePersonId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if payload.SourcePersonID <= 0 || payload.SourcePersonID == targetID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source person must be different"})
		return
	}
	result, err := s.mergeVoicePeople(r.Context(), targetID, payload.SourcePersonID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) listVoiceMergeReviews(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	items, err := s.loadVoiceMergeReviews(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) undoVoiceMergeReview(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	mergeID, err := parseInt64PathValue(r, "mergeId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid merge id"})
		return
	}
	result, err := s.undoVoiceMerge(r.Context(), personID, mergeID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "merge review not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
