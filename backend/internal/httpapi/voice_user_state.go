package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

func (s *Server) updateVoiceUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid voice person id", false)
		return
	}
	payload, err := decodeVoiceUserStateUpdate(r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
		return
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "voice actor not found", false)
			return
		}
		writeError(w, err)
		return
	}
	if payload.CoverPrimaryCode != nil && *payload.CoverPrimaryCode != "" {
		usable, err := s.voiceCoverWorkUsable(r.Context(), personID, *payload.CoverPrimaryCode)
		if err != nil {
			writeError(w, err)
			return
		}
		if !usable {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", errCreatorCoverUnavailable.Error(), false)
			return
		}
	}
	state, err := s.loadVoiceUserState(r.Context(), user.ID, personID)
	if err != nil {
		writeError(w, err)
		return
	}
	state.apply(payload)
	if err := s.persistVoiceUserState(r.Context(), user.ID, personID, state); err != nil {
		writeError(w, err)
		return
	}
	summary, err := s.loadVoiceSummary(r.Context(), user.ID, personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

type voiceUserStateUpdate struct {
	Rating   *int    `json:"rating"`
	Note     *string `json:"note"`
	Favorite *bool   `json:"favorite"`
	// CoverPrimaryCode names the work whose cover the voice actor shows; an
	// empty code restores the latest work's cover.
	CoverPrimaryCode *string `json:"coverPrimaryCode"`
}

type voiceUserStateValues struct {
	Rating   any
	Note     string
	Favorite int
	Cover    string
}

func decodeVoiceUserStateUpdate(r *http.Request) (voiceUserStateUpdate, error) {
	var payload voiceUserStateUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return voiceUserStateUpdate{}, errors.New("invalid json")
	}
	if payload.Rating != nil && (*payload.Rating < 0 || *payload.Rating > 5) {
		return voiceUserStateUpdate{}, errors.New("rating must be between 0 and 5")
	}
	if payload.CoverPrimaryCode != nil {
		code, err := normalizeCreatorCoverCode(*payload.CoverPrimaryCode)
		if err != nil {
			return voiceUserStateUpdate{}, err
		}
		payload.CoverPrimaryCode = &code
	}
	return payload, nil
}

func (s *Server) loadVoiceUserState(ctx context.Context, userID, personID int64) (voiceUserStateValues, error) {
	var currentRating sql.NullInt64
	state := voiceUserStateValues{}
	err := s.db.QueryRowContext(ctx, `
		SELECT rating, COALESCE(note, ''), COALESCE(favorite, 0), cover_primary_code
		FROM user_person_state
		WHERE user_id = ? AND person_id = ?
	`, userID, personID).Scan(&currentRating, &state.Note, &state.Favorite, &state.Cover)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return voiceUserStateValues{}, err
	}
	if currentRating.Valid {
		state.Rating = int(currentRating.Int64)
	}
	return state, nil
}

func (state *voiceUserStateValues) apply(payload voiceUserStateUpdate) {
	if payload.Rating != nil {
		if *payload.Rating > 0 {
			state.Rating = *payload.Rating
		} else {
			state.Rating = nil
		}
	}
	if payload.Note != nil {
		state.Note = strings.TrimSpace(*payload.Note)
	}
	if payload.Favorite != nil {
		state.Favorite = 0
		if *payload.Favorite {
			state.Favorite = 1
		}
	}
	if payload.CoverPrimaryCode != nil {
		state.Cover = *payload.CoverPrimaryCode
	}
}

func (s *Server) persistVoiceUserState(ctx context.Context, userID, personID int64, state voiceUserStateValues) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_person_state (user_id, person_id, rating, note, favorite, cover_primary_code, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, person_id) DO UPDATE SET
			rating = excluded.rating,
			note = excluded.note,
			favorite = excluded.favorite,
			cover_primary_code = excluded.cover_primary_code,
			updated_at = CURRENT_TIMESTAMP
	`, userID, personID, state.Rating, state.Note, state.Favorite, state.Cover)
	return err
}

func (s *Server) setVoiceUserTags(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "tags:write")
	if !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid voice person id", false)
		return
	}
	var payload struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid json", false)
		return
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "voice actor not found", false)
			return
		}
		writeError(w, err)
		return
	}
	tags, err := s.replaceVoiceUserTags(r.Context(), user.ID, personID, payload.Tags)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"personId": personID, "userTags": tags})
}
