package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// takeLibraryOffline makes the fixture's work folder unreadable the way an
// unmounted disk does and returns the function that brings it back. In pool
// mode the work's pool loses its marker; in standard mode the data root is
// left empty, which is how an unmounted library volume looks.
func (fixture lyricsFetchFixture) takeLibraryOffline(t *testing.T) func() {
	t.Helper()
	if fixture.pool != "" {
		fixture.takePoolOffline(t, fixture.pool)
		return func() {
			t.Helper()
			if err := storagepool.WriteMarker(filepath.Join(fixture.dataRoot, fixture.pool), lyricsFetchTestPools[0].ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	unmounted := t.TempDir()
	entries, err := os.ReadDir(fixture.dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if err := os.Rename(filepath.Join(fixture.dataRoot, entry.Name()), filepath.Join(unmounted, entry.Name())); err != nil {
			t.Fatal(err)
		}
	}
	return func() {
		t.Helper()
		for _, entry := range entries {
			if err := os.Rename(filepath.Join(unmounted, entry.Name()), filepath.Join(fixture.dataRoot, entry.Name())); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func (fixture lyricsFetchFixture) workDetail(t *testing.T) workDetail {
	t.Helper()
	request := requestAsAdmin(http.MethodGet, "/api/works/"+jsonNumber(fixture.workID), "", map[string]string{"id": jsonNumber(fixture.workID)})
	response := httptest.NewRecorder()
	fixture.server.getWork(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("work detail status = %d, body = %s", response.Code, response.Body.String())
	}
	var detail workDetail
	if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	return detail
}

// localStates reports how the work detail and the library list show the
// fixture's local track, folder, and presence.
func (fixture lyricsFetchFixture) localStates(t *testing.T, locationID int64) (track string, streamURL string, folder string, presence string, listed string) {
	t.Helper()
	detail := fixture.workDetail(t)
	for _, item := range detail.MediaItems {
		for _, location := range item.Locations {
			if location.ID == locationID {
				track, streamURL = location.Availability, location.StreamURL
			}
		}
	}
	for _, local := range detail.LocalFolders {
		if local.ID == fixture.folderID {
			folder = local.Availability
		}
	}
	for _, item := range detail.SourcePresence {
		if item.Type == "local" && item.WorkID == fixture.workID {
			presence = item.Availability
		}
	}
	request := requestAsAdmin(http.MethodGet, "/api/works?page=1&pageSize=10&status=all", "", nil)
	response := httptest.NewRecorder()
	fixture.server.listWorks(response, request)
	var page struct {
		Works []libraryWorkSummary `json:"works"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatalf("library list: %v, body = %s", err, response.Body.String())
	}
	for _, work := range page.Works {
		if work.ID != fixture.workID {
			continue
		}
		for _, item := range work.SourcePresence {
			if item.Type == "local" && item.WorkID == fixture.workID {
				listed = item.Availability
			}
		}
	}
	return track, streamURL, folder, presence, listed
}

func TestOfflineLibraryReportsLocalItemsOfflineAndRefusesThem(t *testing.T) {
	for name, test := range map[string]struct {
		fixture func(*testing.T) lyricsFetchFixture
		code    string
	}{
		"standard mode": {fixture: func(t *testing.T) lyricsFetchFixture {
			return newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
		}, code: "library_offline"},
		"storage pool mode": {fixture: func(t *testing.T) lyricsFetchFixture {
			return newPoolLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
		}, code: "storage_pool_offline"},
	} {
		t.Run(name, func(t *testing.T) {
			fixture := test.fixture(t)
			locationID, _ := fixture.location(t, "mp3/Track1.Original name.mp3")
			id := jsonNumber(locationID)
			storedAvailability := func() string {
				t.Helper()
				var availability string
				if err := fixture.db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", locationID).Scan(&availability); err != nil {
					t.Fatal(err)
				}
				return availability
			}
			if track, streamURL, folder, presence, listed := fixture.localStates(t, locationID); track != "available" || streamURL == "" ||
				folder != "available" || presence != "available" || listed != "available" {
				t.Fatalf("online states = %q %q %q %q %q", track, streamURL, folder, presence, listed)
			}

			restore := fixture.takeLibraryOffline(t)
			track, streamURL, folder, presence, listed := fixture.localStates(t, locationID)
			if track != localAvailabilityOffline || streamURL != "" || folder != localAvailabilityOffline ||
				presence != localAvailabilityOffline || listed != localAvailabilityOffline {
				t.Fatalf("offline states = %q %q %q %q %q", track, streamURL, folder, presence, listed)
			}
			workID := jsonNumber(fixture.workID)
			for requestName, handler := range map[string]struct {
				handle  http.HandlerFunc
				request *http.Request
			}{
				"stream":   {fixture.server.streamMedia, requestAsAdmin(http.MethodGet, "/api/media/"+id+"/stream", "", map[string]string{"id": id})},
				"download": {fixture.server.downloadMedia, requestAsAdmin(http.MethodGet, "/api/media/"+id+"/download", "", map[string]string{"id": id})},
				"delete":   {fixture.server.deleteMediaLocalLocation, requestAsAdmin(http.MethodDelete, "/api/media/"+id+"/local", "", map[string]string{"id": id})},
				"refresh":  {fixture.server.refreshWorkLocalFiles, requestAsAdmin(http.MethodPost, "/api/works/"+workID+"/local-files/refresh", "", map[string]string{"id": workID})},
			} {
				response := httptest.NewRecorder()
				handler.handle(response, handler.request)
				assertAPIErrorCode(t, requestName, response, http.StatusConflict, test.code)
			}
			// Nothing is recorded as missing or deleted while the library
			// cannot be seen.
			if availability := storedAvailability(); availability != "available" {
				t.Fatalf("stored availability while offline = %q", availability)
			}
			var cleanupRuns int
			if err := fixture.db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code IN ('media_cleanup', 'local_media_delete')").Scan(&cleanupRuns); err != nil || cleanupRuns != 0 {
				t.Fatalf("a refused delete queued %d runs, %v", cleanupRuns, err)
			}

			restore()
			if track, streamURL, folder, presence, listed := fixture.localStates(t, locationID); track != "available" || streamURL == "" ||
				folder != "available" || presence != "available" || listed != "available" {
				t.Fatalf("states after the library returned = %q %q %q %q %q", track, streamURL, folder, presence, listed)
			}
			response := httptest.NewRecorder()
			fixture.server.downloadMedia(response, requestAsAdmin(http.MethodGet, "/api/media/"+id+"/download", "", map[string]string{"id": id}))
			if response.Code != http.StatusOK || response.Body.String() != "synthetic audio" {
				t.Fatalf("download after the library returned: status = %d, body = %q", response.Code, response.Body.String())
			}
		})
	}
}
