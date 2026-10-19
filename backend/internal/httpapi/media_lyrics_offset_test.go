package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLyricsOffsetIsPersonalBoundedAndIndependentOfTheChoice(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO user_account (id, username, role) VALUES (7, 'listener', 'user')",
		"INSERT INTO user_account (id, username, role) VALUES (8, 'other', 'user')",
		"INSERT INTO work (id, primary_code, title) VALUES (11, 'RJ00000040', 'Synthetic work')",
		"INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (21, 11, 'audio', 'Track', 'audio-21')",
		"INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (22, 11, 'text', 'Track lyrics', 'lyrics-22')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	call := func(userID int64, method string, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, "/api/media/21/lyrics-preference", strings.NewReader(body))
		request.SetPathValue("id", "21")
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: userID, Permissions: []string{"playback:use"}}))
		response := httptest.NewRecorder()
		if method == http.MethodDelete {
			server.clearMediaLyricsPreference(response, request)
		} else {
			server.setMediaLyricsPreference(response, request)
		}
		return response
	}

	// An offset alone keeps automatic lyrics.
	if response := call(7, http.MethodPut, `{"lyricsOffsetMs":-1500}`); response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"lyricsMediaItemId":null`) || !strings.Contains(response.Body.String(), `"lyricsOffsetMs":-1500`) {
		t.Fatalf("offset only = %d %s", response.Code, response.Body.String())
	}
	for _, body := range []string{`{"lyricsOffsetMs":30001}`, `{"lyricsOffsetMs":-30001}`, `{}`} {
		if response := call(7, http.MethodPut, body); response.Code != http.StatusBadRequest {
			t.Fatalf("%s = %d, want 400", body, response.Code)
		}
	}
	// Choosing lyrics, then returning to automatic lyrics, keeps the offset.
	if response := call(7, http.MethodPut, `{"lyricsMediaItemId":22}`); !strings.Contains(response.Body.String(), `"lyricsOffsetMs":-1500`) {
		t.Fatalf("choice = %s", response.Body.String())
	}
	if response := call(7, http.MethodDelete, ``); !strings.Contains(response.Body.String(), `"lyricsOffsetMs":-1500`) {
		t.Fatalf("clear choice = %s", response.Body.String())
	}

	detail, err := server.loadWorkDetail(context.Background(), 7, 11, true)
	if err != nil {
		t.Fatal(err)
	}
	if detail.MediaItems[0].LyricsOffsetMs != -1500 {
		t.Fatalf("listener offset = %d", detail.MediaItems[0].LyricsOffsetMs)
	}
	other, err := server.loadWorkDetail(context.Background(), 8, 11, true)
	if err != nil {
		t.Fatal(err)
	}
	if other.MediaItems[0].LyricsOffsetMs != 0 {
		t.Fatal("one listener's offset reached another listener")
	}

	if response := call(7, http.MethodPut, `{"lyricsOffsetMs":0}`); !strings.Contains(response.Body.String(), `"lyricsOffsetMs":0`) {
		t.Fatalf("reset = %s", response.Body.String())
	}
	var rows int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_media_lyrics_offset").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatal("a zero offset was stored")
	}
}
