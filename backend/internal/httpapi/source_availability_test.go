package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// Only a source that answers both its lookup and its listing can say a work is
// absent. A lookup answered 404 whose listing fallback fails is a failed
// check, even though the error text contains "404".
func TestSourceAvailabilityNeedsTheSourceToAnswerNotFound(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/workInfo/") {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "listing unavailable", http.StatusServiceUnavailable)
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	server.dlsiteClient = &unreachableDLsiteClient{}
	metadataReviewExec(t, db, `INSERT INTO file_source (id, code, display_name, source_type) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible')`)
	metadataReviewExec(t, db, `INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (7, ?, ?)`, remote.URL, remote.URL)
	source, err := server.loadRemoteSourceForUse(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}

	availability, err := server.checkOneWorkSourceAvailability(context.Background(), source, "RJ00000000", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if availability.Status != "error" {
		t.Fatalf("availability = %+v, want a failed check rather than not_found", availability)
	}
}

// A failed check is no answer about the work, so the presence the source last
// reported stays; only the time it was asked advances.
func TestFailedSourceAvailabilityCheckKeepsTheStoredPresence(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	metadataReviewExec(t, db, `INSERT INTO file_source (id, code, display_name, source_type) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible')`)
	metadataReviewExec(t, db, `INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work'), (2, 'RJ00000001', 'Example Work 2')`)
	metadataReviewExec(t, db, `INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability, last_checked_at) VALUES (1, 7, ?, 'available', '2026-01-01 00:00:00')`, sourcePresenceTypeRemoteSource)
	for _, code := range []string{"RJ00000000", "RJ00000001"} {
		if err := server.recordSourceAvailabilityObservation(context.Background(), code, []sourceAvailabilitySummary{{SourceID: 7, Status: "error"}}); err != nil {
			t.Fatal(err)
		}
	}
	var availability, checkedAt string
	if err := db.QueryRow(`SELECT availability, last_checked_at FROM work_source_presence WHERE work_id = 1 AND file_source_id = 7`).Scan(&availability, &checkedAt); err != nil {
		t.Fatal(err)
	}
	if availability != "available" || checkedAt == "2026-01-01 00:00:00" {
		t.Fatalf("stored presence = %q checked %q, want available and asked again", availability, checkedAt)
	}
	if err := db.QueryRow(`SELECT availability FROM work_source_presence WHERE work_id = 2 AND file_source_id = 7`).Scan(&availability); err != nil || availability != "unknown" {
		t.Fatalf("never-answered presence = %q, %v", availability, err)
	}
}
