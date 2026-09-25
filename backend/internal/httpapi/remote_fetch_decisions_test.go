package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestRemoteFetchSourceOptionsLoadsAlternativeSourcesAfterReleasingCursor(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workInfo/RJ00000001":
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 101, SourceID: "RJ00000001", Title: "Example Work"})
		case "/api/tracks/101":
			_ = json.NewEncoder(w).Encode([]kikoeru.Track{{
				Type: "audio", Title: "alternate.wav", Hash: "fixture-hash", MediaDownloadURL: "/media/alternate.wav",
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	db := openMigratedTestDB(t)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{query: "INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Example Work')"},
		{query: `INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES
			(7, 'example_primary', 'Example Primary', 'kikoeru_compatible', 10, 1),
			(8, 'example_alternate', 'Example Alternate', 'kikoeru_compatible', 20, 1)`},
		{query: "INSERT INTO file_source_endpoint (file_source_id, api_url, base_url, restrict_outbound_hosts) VALUES (8, ?, ?, 1)", args: []any{upstream.URL, upstream.URL}},
		{query: "INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (1, 8, 'source', 'available')"},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	primary := remoteSourceForUse{ID: 7, Code: "example_primary", DisplayName: "Example Primary"}
	primaryFiles := []remoteSaveFile{{Path: "primary.wav", Kind: "audio", DownloadURL: "/media/primary.wav", Hash: "fixture-hash"}}

	// The single test connection turns a remote lookup under the open candidate
	// cursor into a deadline failure instead of a hang.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	options := server.remoteFetchSourceOptions(ctx, primary, "RJ00000001", primaryFiles)

	group := options["primary.wav"]
	if len(group) != 2 || group[0].SourceID != 7 || group[1].SourceID != 8 || group[1].Path != "alternate.wav" {
		t.Fatalf("primary.wav source options = %#v, want primary then hash-matched alternate", group)
	}
}
