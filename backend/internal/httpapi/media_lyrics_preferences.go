package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

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
		LyricsMediaItemID int64 `json:"lyricsMediaItemId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.LyricsMediaItemID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lyricsMediaItemId is required"})
		return
	}
	var audioWorkID, lyricsWorkID int64
	var audioKind, lyricsKind string
	if err := s.db.QueryRowContext(r.Context(), "SELECT work_id, kind FROM media_item WHERE id = ?", audioID).Scan(&audioWorkID, &audioKind); err != nil {
		writeMediaPreferenceLookupError(w, err)
		return
	}
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
	`, payload.LyricsMediaItemID).Scan(&lyricsWorkID, &lyricsKind, &lyricsPath); err != nil {
		writeMediaPreferenceLookupError(w, err)
		return
	}
	if audioKind != "audio" || (lyricsKind != "text" && !(lyricsKind == "file" && isTextFile(lyricsPath))) || audioWorkID != lyricsWorkID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lyrics preference must link audio and text media from the same work"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_media_lyrics_preference (user_id, audio_media_item_id, lyrics_media_item_id)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, audio_media_item_id) DO UPDATE SET
			lyrics_media_item_id = excluded.lyrics_media_item_id,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, audioID, payload.LyricsMediaItemID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audioMediaItemId": audioID, "lyricsMediaItemId": payload.LyricsMediaItemID})
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
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM user_media_lyrics_preference WHERE user_id = ? AND audio_media_item_id = ?", user.ID, audioID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audioMediaItemId": audioID, "lyricsMediaItemId": nil})
}

func writeMediaPreferenceLookupError(w http.ResponseWriter, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media item not found"})
		return
	}
	writeError(w, err)
}
