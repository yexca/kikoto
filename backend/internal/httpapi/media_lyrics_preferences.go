package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// lyricsOffsetLimitMs bounds a listener's lyrics timing offset.
const lyricsOffsetLimitMs = 30_000

// setMediaLyricsPreference stores the viewer's lyrics choice, lyrics timing
// offset, or both for an audio media item. A field left out keeps its value;
// an offset of 0 removes the offset.
func (s *Server) setMediaLyricsPreference(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	audioID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid audio media item id"})
		return
	}
	var payload struct {
		LyricsMediaItemID *int64 `json:"lyricsMediaItemId"`
		LyricsOffsetMs    *int64 `json:"lyricsOffsetMs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil ||
		(payload.LyricsMediaItemID == nil && payload.LyricsOffsetMs == nil) ||
		(payload.LyricsMediaItemID != nil && *payload.LyricsMediaItemID <= 0) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lyricsMediaItemId or lyricsOffsetMs is required"})
		return
	}
	if payload.LyricsOffsetMs != nil && (*payload.LyricsOffsetMs < -lyricsOffsetLimitMs || *payload.LyricsOffsetMs > lyricsOffsetLimitMs) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lyricsOffsetMs must be between -30000 and 30000"})
		return
	}
	var audioWorkID int64
	var audioKind string
	if err := s.db.QueryRowContext(r.Context(), "SELECT work_id, kind FROM media_item WHERE id = ?", audioID).Scan(&audioWorkID, &audioKind); err != nil {
		writeMediaPreferenceLookupError(w, err)
		return
	}
	if audioKind != "audio" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lyrics preference must link audio and text media from the same work"})
		return
	}
	if payload.LyricsMediaItemID != nil && !s.validLyricsPreferenceTarget(w, r, audioWorkID, *payload.LyricsMediaItemID) {
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if payload.LyricsMediaItemID != nil {
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO user_media_lyrics_preference (user_id, audio_media_item_id, lyrics_media_item_id)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id, audio_media_item_id) DO UPDATE SET
				lyrics_media_item_id = excluded.lyrics_media_item_id,
				updated_at = CURRENT_TIMESTAMP
		`, user.ID, audioID, *payload.LyricsMediaItemID); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.LyricsOffsetMs != nil {
		if err := setLyricsOffset(r.Context(), tx, user.ID, audioID, *payload.LyricsOffsetMs); err != nil {
			writeError(w, err)
			return
		}
	}
	response, err := lyricsPreferenceResponse(r.Context(), tx, user.ID, audioID)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func setLyricsOffset(ctx context.Context, tx *sql.Tx, userID, audioID, offsetMs int64) error {
	if offsetMs == 0 {
		_, err := tx.ExecContext(ctx, "DELETE FROM user_media_lyrics_offset WHERE user_id = ? AND audio_media_item_id = ?", userID, audioID)
		return err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO user_media_lyrics_offset (user_id, audio_media_item_id, offset_ms)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, audio_media_item_id) DO UPDATE SET
			offset_ms = excluded.offset_ms,
			updated_at = CURRENT_TIMESTAMP
	`, userID, audioID, offsetMs)
	return err
}

func lyricsPreferenceResponse(ctx context.Context, tx *sql.Tx, userID, audioID int64) (map[string]any, error) {
	var lyricsID sql.NullInt64
	var offsetMs int64
	if err := tx.QueryRowContext(ctx, `
		SELECT
			(SELECT lyrics_media_item_id FROM user_media_lyrics_preference WHERE user_id = ? AND audio_media_item_id = ?),
			COALESCE((SELECT offset_ms FROM user_media_lyrics_offset WHERE user_id = ? AND audio_media_item_id = ?), 0)
	`, userID, audioID, userID, audioID).Scan(&lyricsID, &offsetMs); err != nil {
		return nil, err
	}
	var lyrics any
	if lyricsID.Valid {
		lyrics = lyricsID.Int64
	}
	return map[string]any{"audioMediaItemId": audioID, "lyricsMediaItemId": lyrics, "lyricsOffsetMs": offsetMs}, nil
}

// validLyricsPreferenceTarget reports whether lyricsID is text media of the
// audio's work, writing the error response when it is not.
func (s *Server) validLyricsPreferenceTarget(w http.ResponseWriter, r *http.Request, audioWorkID, lyricsID int64) bool {
	var lyricsWorkID int64
	var lyricsKind string
	var lyricsPath string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT item.work_id, item.kind, COALESCE((
			SELECT location.path
			FROM media_file_location AS location
			WHERE location.media_item_id = item.id AND location.availability = 'available'
			ORDER BY location.id
			LIMIT 1
		), item.title)
		FROM media_item AS item
		WHERE item.id = ?
	`, lyricsID).Scan(&lyricsWorkID, &lyricsKind, &lyricsPath); err != nil {
		writeMediaPreferenceLookupError(w, err)
		return false
	}
	if !isLyricsMediaKind(lyricsKind, lyricsPath) || audioWorkID != lyricsWorkID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lyrics preference must link audio and text media from the same work"})
		return false
	}
	return true
}

func (s *Server) clearMediaLyricsPreference(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	audioID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid audio media item id"})
		return
	}
	// The offset stays: it describes the timing of this audio, not the choice
	// of lyrics file.
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM user_media_lyrics_preference WHERE user_id = ? AND audio_media_item_id = ?", user.ID, audioID); err != nil {
		writeError(w, err)
		return
	}
	var offsetMs int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COALESCE((SELECT offset_ms FROM user_media_lyrics_offset WHERE user_id = ? AND audio_media_item_id = ?), 0)", user.ID, audioID).Scan(&offsetMs); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audioMediaItemId": audioID, "lyricsMediaItemId": nil, "lyricsOffsetMs": offsetMs})
}

// isLyricsMediaKind reports whether a media item can be shown as lyrics: a
// text item, or a generic file whose name is a known text format.
func isLyricsMediaKind(kind string, path string) bool {
	return kind == "text" || (kind == "file" && isTextFile(path))
}

func writeMediaPreferenceLookupError(w http.ResponseWriter, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media item not found"})
		return
	}
	writeError(w, err)
}
