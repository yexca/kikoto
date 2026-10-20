package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/personal"
)

func writePersonalError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, personal.ErrHistoryCleared):
		writeAPIError(w, http.StatusConflict, "listening_history_cleared", "Listening history was cleared. Start a new listening session.", false)
	case errors.Is(err, personal.ErrInvalid):
		writeAPIError(w, http.StatusBadRequest, "invalid_personal_data", "Invalid personal data or unsupported backup format.", false)
	case errors.Is(err, personal.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "not_found", "Personal record or work not found.", false)
	case errors.Is(err, personal.ErrConflict):
		writeAPIError(w, http.StatusConflict, "personal_data_conflict", "The name or work identity conflicts with another record.", false)
	case errors.Is(err, personal.ErrLimit):
		writeAPIError(w, http.StatusRequestEntityTooLarge, "personal_data_limit", "Personal data exceeds the supported transfer limits.", false)
	default:
		writeError(w, err)
	}
}

func decodePersonalBody(w http.ResponseWriter, r *http.Request, target any, limit int64) bool {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writePersonalError(w, personal.ErrLimit)
		} else {
			writePersonalError(w, personal.ErrInvalid)
		}
		return false
	}
	if err = personal.DecodeJSON(data, target, true); err != nil {
		writePersonalError(w, err)
		return false
	}
	return true
}

func (s *Server) listPersonalTags(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	result, err := (personal.Store{DB: s.db}).Tags(r.Context(), user.ID, r.URL.Query().Get("scope"), r.URL.Query().Get("q"), queryInt(r, "page", 1), queryInt(r, "pageSize", 50))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) changePersonalTag(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "tags:write")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writePersonalError(w, personal.ErrInvalid)
		return
	}
	var payload struct {
		Name     string `json:"name"`
		TargetID int64  `json:"targetId"`
	}
	action := "delete"
	if r.Method != http.MethodDelete {
		if !decodePersonalBody(w, r, &payload, 2048) {
			return
		}
		action = "rename"
		if r.Method == http.MethodPost {
			action = "merge"
		}
	}
	tag, err := (personal.Store{DB: s.db}).ChangeTag(r.Context(), user.ID, r.URL.Query().Get("scope"), id, action, payload.Name, payload.TargetID)
	if err != nil {
		writePersonalError(w, err)
		return
	}
	if action == "delete" {
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
		return
	}
	writeJSON(w, http.StatusOK, tag)
}

func (s *Server) getListeningGeneration(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	generation, err := (personal.Store{DB: s.db}).ListeningGeneration(r.Context(), user.ID)
	if err != nil {
		writePersonalError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	// A client buckets listening by the calendar day of the account's time
	// zone; null tells it to follow its own device.
	var timeZone any
	if name, ok := s.ownTimeZone(r.Context(), user.ID); ok {
		timeZone = name
	}
	// hours tells it that dated reports may split each day by hour.
	writeJSON(w, http.StatusOK, map[string]any{"generation": generation, "timeZone": timeZone, "hours": true})
}

func (s *Server) recordListeningSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	var payload personal.SessionInput
	if !decodePersonalBody(w, r, &payload, 2048) {
		return
	}
	payload.Day = s.accountNow(r, user.ID).Format(time.DateOnly)
	if err := (personal.Store{DB: s.db}).RecordSession(r.Context(), user.ID, payload); err != nil {
		writePersonalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"recorded": true})
}

func (s *Server) getListeningHistory(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	result, err := (personal.Store{DB: s.db}).History(r.Context(), user.ID, r.URL.Query().Get("q"), queryInt(r, "page", 1), queryInt(r, "pageSize", 30))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	s.attachListeningCovers(result.Items)
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getListeningStatistics(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	period, err := personal.ParseStatisticsRange(r.URL.Query().Get("range"))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	result, err := (personal.Store{DB: s.db}).StatisticsFor(r.Context(), user.ID, period, s.accountNow(r, user.ID))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	s.attachListeningCovers(result.TopWorks)
	if result.Highlights != nil && result.Highlights.BusiestDay != nil && result.Highlights.BusiestDay.TopWork != nil {
		work := result.Highlights.BusiestDay.TopWork
		work.CoverURL = s.coverURL(work.PrimaryCode)
	}
	if result.Highlights != nil && result.Highlights.TopVoice != nil {
		voices := []personal.BreakdownEntry{*result.Highlights.TopVoice}
		if err = s.attachListeningVoiceRouteKeys(r.Context(), voices); err != nil {
			writePersonalError(w, err)
			return
		}
		result.Highlights.TopVoice = &voices[0]
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getListeningCalendar(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	// A year shows that year; every other range shows the weeks up to today.
	period, err := personal.ParseStatisticsRange(r.URL.Query().Get("range"))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	result, err := (personal.Store{DB: s.db}).CalendarFor(r.Context(), user.ID, period, s.accountNow(r, user.ID))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	_, followsDevice := s.accountTimeZone(r, user.ID)
	writeJSON(w, http.StatusOK, struct {
		personal.Calendar
		// FollowsDevice reports that the account fixed no zone of its own.
		FollowsDevice bool `json:"followsDevice"`
	}{result, followsDevice})
}

func (s *Server) getListeningBreakdown(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	period, err := personal.ParseStatisticsRange(r.URL.Query().Get("range"))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	rank, err := personal.ParseBreakdownRank(r.URL.Query().Get("rank"))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	result, err := (personal.Store{DB: s.db}).BreakdownFor(r.Context(), user.ID, period, rank, s.accountNow(r, user.ID))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	if err = s.localizeListeningTags(r.Context(), result.Tags); err != nil {
		writePersonalError(w, err)
		return
	}
	if err = s.attachListeningVoiceRouteKeys(r.Context(), result.Voices); err != nil {
		writePersonalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// attachListeningVoiceRouteKeys sets the route key of each ranked voice.
func (s *Server) attachListeningVoiceRouteKeys(ctx context.Context, voices []personal.BreakdownEntry) error {
	personIDs := make([]int64, 0, len(voices))
	for _, voice := range voices {
		personIDs = append(personIDs, voice.ID)
	}
	keys, err := s.voiceRouteKeys(ctx, personIDs)
	if err != nil {
		return err
	}
	for index := range voices {
		voices[index].RouteKey = keys[voices[index].ID]
	}
	return nil
}

func (s *Server) getListeningProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	period, err := personal.ParseStatisticsRange(r.URL.Query().Get("range"))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	result, err := (personal.Store{DB: s.db}).ProfileFor(r.Context(), user.ID, period, s.accountNow(r, user.ID))
	if err != nil {
		writePersonalError(w, err)
		return
	}
	if err = s.localizeListeningTags(r.Context(), result.Tags); err != nil {
		writePersonalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// localizeListeningTags names shared tags in the viewer's metadata language,
// like a work's own tags.
func (s *Server) localizeListeningTags(ctx context.Context, tags []personal.BreakdownEntry) error {
	languages := s.viewerTagLanguages(ctx)
	if languages == nil || len(tags) == 0 {
		return nil
	}
	ids := make([]int64, len(tags))
	for index, tag := range tags {
		ids[index] = tag.ID
	}
	names, err := metadatatags.LocalizedNames(ctx, s.db, ids, languages)
	if err != nil {
		return err
	}
	for index, tag := range tags {
		if name, ok := names[tag.ID]; ok {
			tags[index].Name = name
		}
	}
	return nil
}

// History records store the canonical work, so its own cached cover applies.
func (s *Server) attachListeningCovers(items []personal.HistoryItem) {
	for index := range items {
		items[index].CoverURL = s.coverURL(items[index].PrimaryCode)
	}
}

func (s *Server) clearListeningHistory(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	if err := (personal.Store{DB: s.db}).ClearHistory(r.Context(), user.ID); err != nil {
		writePersonalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) exportPersonalData(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	data, err := (personal.Store{DB: s.db}).Export(r.Context(), user.ID)
	if err != nil {
		writePersonalError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="kikoto-user-data.json"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) importPersonalData(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	for _, permission := range []string{"tags:write", "playback:use"} {
		if _, ok = s.requirePermission(w, r, permission); !ok {
			return
		}
	}
	var payload personal.ImportRequest
	if !decodePersonalBody(w, r, &payload, personal.MaxTransferBytes+1024) {
		return
	}
	b, err := personal.ParseImport(payload)
	if err != nil {
		writePersonalError(w, err)
		return
	}
	store := personal.Store{DB: s.db}
	if r.URL.Path == "/api/user-data/import/preview" {
		preview, err := store.PreviewImport(r.Context(), user.ID, b)
		if err != nil {
			writePersonalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preview)
		return
	}
	result, err := store.Import(r.Context(), user.ID, b, payload.Conflict == "overwrite")
	if err != nil {
		writePersonalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
