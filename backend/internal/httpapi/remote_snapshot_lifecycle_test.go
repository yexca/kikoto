package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestRemoteSnapshotRejectsLateWorkAndTracksAfterSourceChanges(t *testing.T) {
	for _, stage := range []string{"work", "tracks"} {
		for _, mutation := range []string{"update", "disable", "delete", "invalidate"} {
			t.Run(stage+"/"+mutation, func(t *testing.T) {
				started, release := make(chan struct{}), make(chan struct{})
				old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if (stage == "work" && strings.Contains(r.URL.Path, "workInfo")) || (stage == "tracks" && strings.Contains(r.URL.Path, "tracks")) {
						close(started)
						<-release
					}
					writeRemoteSnapshotFixture(w, r, "Example old")
				}))
				defer old.Close()
				fresh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					writeRemoteSnapshotFixture(w, r, "Example current")
				}))
				defer fresh.Close()
				s := newRemoteTextPreviewServer(t, old.URL, old.URL+"/media/track.mp3")
				clear(s.remoteWorkCache)
				clear(s.remoteWorkTracksCache)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				completed := make(chan error, 1)
				go func() {
					if stage == "work" {
						_, _, err := s.loadRemoteWorkCached(ctx, 7, "RJ00000000")
						completed <- err
					} else {
						_, _, _, err := s.loadRemoteWorkTracksCached(ctx, 7, "RJ00000000")
						completed <- err
					}
				}()
				select {
				case <-started:
				case <-ctx.Done():
					close(release)
					t.Fatal("old request did not start")
				}
				s.remoteSourceConfigMu.Lock()
				var err error
				switch mutation {
				case "update":
					err = setRemoteSnapshotEndpoint(s, fresh.URL)
				case "disable":
					_, err = s.db.Exec("UPDATE file_source SET enabled = 0 WHERE id = 7")
				case "delete":
					_, err = s.db.Exec("DELETE FROM file_source WHERE id = 7")
				}
				s.invalidateRemoteWorkCache(7)
				s.remoteSourceConfigMu.Unlock()
				if err != nil {
					close(release)
					t.Fatal(err)
				}
				if mutation == "update" {
					// A fresh caller must complete independently of the old gate.
					source, work, tracks, err := s.loadRemoteWorkTracksCached(ctx, 7, "RJ00000000")
					if err != nil || source.Endpoint.APIURL != fresh.URL || work.Title != "Example current" || len(tracks) != 1 || tracks[0].Title != "Example current" {
						close(release)
						t.Fatalf("fresh request joined old call: %+v %+v %+v %v", source, work, tracks, err)
					}
				} else if mutation != "invalidate" {
					if _, _, _, err := s.loadRemoteWorkTracksCached(ctx, 7, "RJ00000000"); err == nil {
						close(release)
						t.Fatal("disabled/deleted source served a cached result")
					}
				}
				close(release)
				if err := <-completed; !errors.Is(err, errRemoteSourceChanged) {
					t.Fatalf("late request error = %v", err)
				}
				s.remoteWorkCacheMu.Lock()
				defer s.remoteWorkCacheMu.Unlock()
				for _, snapshot := range s.remoteWorkCache {
					if snapshot.Work.Title == "Example old" {
						t.Fatal("old work was republished")
					}
				}
				for _, snapshot := range s.remoteWorkTracksCache {
					if snapshot.Work.Title == "Example old" {
						t.Fatal("old tracks were republished")
					}
				}
			})
		}
	}
}

func setRemoteSnapshotEndpoint(s *Server, endpoint string) error {
	_, err := s.db.Exec("UPDATE file_source_endpoint SET api_url = ?, base_url = ? WHERE file_source_id = 7", endpoint, endpoint)
	return err
}

func writeRemoteSnapshotFixture(w http.ResponseWriter, r *http.Request, title string) {
	w.Header().Set("Content-Type", "application/json")
	if strings.Contains(r.URL.Path, "workInfo") {
		_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 71, SourceID: "RJ00000000", Title: title})
	} else {
		_ = json.NewEncoder(w).Encode([]kikoeru.Track{{Type: "audio", Title: title}})
	}
}

func TestRemoteCacheReadsCurrentSourcePolicyEvenWithoutExplicitInvalidation(t *testing.T) {
	s := newRemoteTextPreviewServer(t, "https://source.example.invalid", "https://media.example.invalid/track.mp3")
	if _, err := s.db.Exec("UPDATE file_source SET enabled = 0 WHERE id = 7"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.loadRemoteWorkTracksCached(context.Background(), 7, "RJ00000000"); err == nil {
		t.Fatal("cached source configuration bypassed the live enabled state")
	}
}
