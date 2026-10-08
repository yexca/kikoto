package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func seedLyricsAssignmentFamily(t *testing.T) *sql.DB {
	t.Helper()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, role) VALUES (7, 'synthetic-user', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(11, 'RJ00000001', 'Example Work 1'),
			(12, 'RJ00000002', 'Example Work 2'),
			(13, 'RJ00000003', 'Example Work 3');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (11, 11, 'RJ00000001');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, is_canonical) VALUES
			(11, 11, 'RJ00000001', 'RJ00000001', 'JPN', 1),
			(12, 11, 'RJ00000002', 'RJ00000001', 'CHI_HANS', 0);
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(21, 11, 'audio', 'Track 1', 'audio-21'),
			(22, 11, 'text', 'Track 1 lyrics', 'lyrics-22'),
			(23, 11, 'text', 'Alternate lyrics', 'lyrics-23'),
			(31, 12, 'audio', 'Translated track', 'audio-31'),
			(32, 12, 'file', 'translated.vtt', 'lyrics-32'),
			(41, 13, 'audio', 'Unrelated track', 'audio-41'),
			(42, 13, 'text', 'Unrelated lyrics', 'lyrics-42');
	`); err != nil {
		t.Fatal(err)
	}
	return db
}

func putLyricsAssignments(server *Server, workID string, body string, permissions ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, "/api/works/"+workID+"/lyrics-assignments", strings.NewReader(body))
	request.SetPathValue("id", workID)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 7, Permissions: permissions}))
	response := httptest.NewRecorder()
	server.setWorkLyricsAssignments(response, request)
	return response
}

func assignedLyricsFor(t *testing.T, db *sql.DB, audioID int64) (int64, bool) {
	t.Helper()
	var lyricsID int64
	err := db.QueryRow("SELECT lyrics_media_item_id FROM media_lyrics_assignment WHERE audio_media_item_id = ?", audioID).Scan(&lyricsID)
	if err == sql.ErrNoRows {
		return 0, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return lyricsID, true
}

func TestLyricsAssignmentsAreSharedAndIndependentOfPersonalPreference(t *testing.T) {
	db := seedLyricsAssignmentFamily(t)
	if _, err := db.Exec("INSERT INTO user_media_lyrics_preference (user_id, audio_media_item_id, lyrics_media_item_id) VALUES (7, 21, 23)"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})

	// A translated edition's media is reachable from the family's canonical work.
	response := putLyricsAssignments(server, "11", `{"assignments":[
		{"audioMediaItemId":21,"lyricsMediaItemId":22},
		{"audioMediaItemId":31,"lyricsMediaItemId":32}
	]}`, "library:write")
	if response.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", response.Code, response.Body.String())
	}
	var origin string
	var assignedBy sql.NullInt64
	if err := db.QueryRow("SELECT origin, assigned_by_user_id FROM media_lyrics_assignment WHERE audio_media_item_id = 21").Scan(&origin, &assignedBy); err != nil {
		t.Fatal(err)
	}
	if origin != "manual" || !assignedBy.Valid || assignedBy.Int64 != 7 {
		t.Fatalf("assignment provenance = %q/%v, want manual by user 7", origin, assignedBy)
	}

	items, err := server.loadWorkMediaItems(context.Background(), 7, 11)
	if err != nil {
		t.Fatal(err)
	}
	var audio mediaItemDetail
	for _, item := range items {
		if item.ID == 21 {
			audio = item
		}
	}
	if audio.AssignedLyricsMediaItemID == nil || *audio.AssignedLyricsMediaItemID != 22 {
		t.Fatalf("assigned lyrics = %v, want 22", audio.AssignedLyricsMediaItemID)
	}
	if audio.PreferredLyricsMediaItemID == nil || *audio.PreferredLyricsMediaItemID != 23 {
		t.Fatalf("personal preference changed to %v, want 23", audio.PreferredLyricsMediaItemID)
	}

	response = putLyricsAssignments(server, "11", `{"assignments":[{"audioMediaItemId":21,"lyricsMediaItemId":null}]}`, "library:write")
	if response.Code != http.StatusOK {
		t.Fatalf("clear status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, ok := assignedLyricsFor(t, db, 21); ok {
		t.Fatal("cleared assignment is still stored")
	}
	if lyricsID, ok := assignedLyricsFor(t, db, 31); !ok || lyricsID != 32 {
		t.Fatalf("unrelated assignment changed: %d %v", lyricsID, ok)
	}
}

func TestLyricsAssignmentsRejectInvalidLinksAtomically(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		body   string
		status int
	}{
		{name: "lyrics from another edition", body: `{"assignments":[{"audioMediaItemId":21,"lyricsMediaItemId":32}]}`, status: http.StatusBadRequest},
		{name: "audio outside the family", body: `{"assignments":[{"audioMediaItemId":41,"lyricsMediaItemId":42}]}`, status: http.StatusBadRequest},
		{name: "text item as the audio target", body: `{"assignments":[{"audioMediaItemId":22,"lyricsMediaItemId":23}]}`, status: http.StatusBadRequest},
		{name: "audio item as lyrics", body: `{"assignments":[{"audioMediaItemId":21,"lyricsMediaItemId":21}]}`, status: http.StatusBadRequest},
		{name: "missing lyrics item", body: `{"assignments":[{"audioMediaItemId":21,"lyricsMediaItemId":999}]}`, status: http.StatusNotFound},
		{name: "duplicate audio item", body: `{"assignments":[{"audioMediaItemId":21,"lyricsMediaItemId":22},{"audioMediaItemId":21,"lyricsMediaItemId":23}]}`, status: http.StatusBadRequest},
		{name: "empty request", body: `{"assignments":[]}`, status: http.StatusBadRequest},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			db := seedLyricsAssignmentFamily(t)
			server := NewServer(db, config.Config{})
			// A valid change earlier in the same request must roll back with the
			// invalid one.
			body := strings.Replace(testCase.body, `{"assignments":[`, `{"assignments":[{"audioMediaItemId":31,"lyricsMediaItemId":32},`, 1)
			if testCase.name == "empty request" {
				body = testCase.body
			}
			response := putLyricsAssignments(server, "11", body, "library:write")
			if response.Code != testCase.status {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, testCase.status, response.Body.String())
			}
			if _, ok := assignedLyricsFor(t, db, 31); ok {
				t.Fatal("a rejected request stored part of its assignments")
			}
		})
	}
}

func TestLyricsAssignmentsRequireLibraryWrite(t *testing.T) {
	db := seedLyricsAssignmentFamily(t)
	server := NewServer(db, config.Config{})
	response := putLyricsAssignments(server, "11", `{"assignments":[{"audioMediaItemId":21,"lyricsMediaItemId":22}]}`, "playback:use")
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
	if _, ok := assignedLyricsFor(t, db, 21); ok {
		t.Fatal("assignment was stored without library:write")
	}
	if response := putLyricsAssignments(server, "999", `{"assignments":[{"audioMediaItemId":21,"lyricsMediaItemId":22}]}`, "library:write"); response.Code != http.StatusNotFound {
		t.Fatalf("unknown work status = %d, want 404", response.Code)
	}
}
