package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func TestOrderedPlaybackLocationsPreferLocalThenCacheThenRemote(t *testing.T) {
	item := mediaItemDetail{Kind: "audio", Locations: []fileLocationDetail{
		{ID: 1, LocationType: "remote_stream", StreamURL: "https://source.example.invalid/a.mp3", Availability: "remote"},
		{ID: 2, LocationType: "cache", StreamURL: "/api/media/2/stream", Availability: "available"},
		{ID: 3, LocationType: "local", StreamURL: "/api/media/3/stream", Availability: localAvailabilityOffline},
		{ID: 4, LocationType: "local", StreamURL: "/api/media/4/stream", Availability: "available"},
		{ID: 5, LocationType: "local", StreamURL: "/api/media/5/stream", Availability: "available"},
		{ID: 6, LocationType: "local", Availability: "missing"},
	}}
	locations := orderedPlaybackLocations(item)
	got := []int64{}
	for _, location := range locations {
		got = append(got, location.LocationID)
	}
	if jsonString(t, got) != "[4,5,2,1]" {
		t.Fatalf("playback locations = %v, want local 4 and 5, cache 2, remote 1; never the offline or missing file", got)
	}
	if remote := locations[3]; remote.StreamURL != "/api/media/1/stream" {
		t.Fatalf("remote audio streams through %q, want its own route", remote.StreamURL)
	}

	downloadOnly := fileLocationDetail{ID: 7, LocationType: "remote_stream", DownloadURL: "https://source.example.invalid/clip.avi", Availability: "remote"}
	if video := orderedPlaybackLocations(mediaItemDetail{Kind: "video", Locations: []fileLocationDetail{downloadOnly}}); len(video) != 1 || video[0].StreamURL != "/api/media/7/stream" {
		t.Fatalf("remote video with only a download URL = %#v, want its own stream route", video)
	}
	if image := orderedPlaybackLocations(mediaItemDetail{Kind: "image", Locations: []fileLocationDetail{downloadOnly}}); len(image) != 1 || image[0].StreamURL != downloadOnly.DownloadURL {
		t.Fatalf("remote image = %#v, want its download URL", image)
	}

	if kept := keptPlaybackLocation(locations, 5, false); kept.LocationID != 5 {
		t.Fatalf("another local folder of the same file moved to %d", kept.LocationID)
	}
	if kept := keptPlaybackLocation(locations, 2, false); kept.LocationID != 4 {
		t.Fatalf("a cached copy stayed at %d over the local file", kept.LocationID)
	}
	if kept := keptPlaybackLocation(locations, 1, true); kept.LocationID != 1 {
		t.Fatalf("the location the listener picked moved to %d", kept.LocationID)
	}
	if kept := keptPlaybackLocation(locations, 3, true); kept.LocationID != 4 {
		t.Fatalf("a picked location on an offline pool stayed: %d", kept.LocationID)
	}
}

func jsonString(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func seedPlaybackQueueWork(t *testing.T, db *sqlutil.DB) account.User {
	t.Helper()
	result, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('queue-user', 'Queue User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := result.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (801, 'RJ00000000', 'Example Work');
		INSERT INTO file_source (id, code, display_name, source_type, priority) VALUES
			(811, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1),
			(812, 'example_local', 'Example Local', 'local_folder', 0);
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(821, 801, 'audio', 'track 10.mp3', 'queue-track-10'),
			(822, 801, 'audio', 'track 2.mp3', 'queue-track-2'),
			(823, 801, 'audio', 'bonus.mp3', 'queue-bonus'),
			(824, 801, 'audio', 'gone.mp3', 'queue-gone'),
			(825, 801, 'text', 'track 2.lrc', 'queue-lyrics');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, stream_url, availability) VALUES
			(831, 821, 812, 'local', 'RJ00000000/Main/track 10.mp3', '', 'available'),
			(832, 822, 811, 'cache', 'example_remote_a/RJ00000000/Main/track 2.mp3', '', 'available'),
			(833, 822, 812, 'local', 'RJ00000000/Main/track 2.mp3', '', 'available'),
			(834, 822, 811, 'remote_stream', 'Main/track 2.mp3', 'https://source.example.invalid/track2.mp3', 'remote'),
			(835, 823, 812, 'local', 'RJ00000000/Extra/Bonus/bonus.mp3', '', 'available'),
			(836, 824, 812, 'local', 'RJ00000000/Main/gone.mp3', '', 'missing'),
			(837, 825, 812, 'local', 'RJ00000000/Main/track 2.lrc', '', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	return account.User{ID: userID, Username: "queue-user", Role: "user", Permissions: account.PermissionsForRole("user")}
}

func resolveQueue(t *testing.T, server *Server, user account.User, body string) playbackQueueResolveResponse {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/playback/queue/resolve", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response := httptest.NewRecorder()
	server.resolvePlaybackQueue(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body = %s", response.Code, response.Body.String())
	}
	var resolved playbackQueueResolveResponse
	if err := json.Unmarshal(response.Body.Bytes(), &resolved); err != nil {
		t.Fatal(err)
	}
	return resolved
}

func TestResolvePlaybackQueueReportsEveryItemInOneResponse(t *testing.T) {
	db := openMigratedTestDB(t)
	user := seedPlaybackQueueWork(t, db)
	server := NewServer(db, config.Config{DataRoot: t.TempDir()})

	resolved := resolveQueue(t, server, user, `{"items":[
		{"mediaItemId":822,"workId":801,"locationId":832},
		{"mediaItemId":822,"workId":801,"locationId":834,"locationChosen":true},
		{"mediaItemId":824,"workId":801,"locationId":836},
		{"mediaItemId":899,"workId":801,"locationId":0},
		{"mediaItemId":821,"workId":899,"locationId":831}
	]}`)
	statuses := []string{}
	for _, item := range resolved.Items {
		statuses = append(statuses, item.Status)
	}
	if got := strings.Join(statuses, ","); got != "playable,playable,unavailable,missing,missing" {
		t.Fatalf("statuses = %s", got)
	}
	cached := resolved.Items[0].Track
	if cached.LocationID != 833 || cached.LocationType != "local" || cached.StreamURL != "/api/media/833/stream" {
		t.Fatalf("a track saved on its cached copy plays from %d %s %q, want the local file", cached.LocationID, cached.LocationType, cached.StreamURL)
	}
	if len(cached.Locations) != 3 || cached.Locations[0].LocationID != 833 || cached.Locations[1].LocationID != 832 || cached.Locations[2].LocationID != 834 {
		t.Fatalf("locations = %#v", cached.Locations)
	}
	if len(cached.LyricsChoices) != 1 || cached.LyricsChoices[0].MediaItemID != 825 || cached.LyricsChoices[0].Title != "track 2.lrc" {
		t.Fatalf("lyrics choices = %#v", cached.LyricsChoices)
	}
	if chosen := resolved.Items[1].Track; chosen.LocationID != 834 || chosen.StreamURL != "/api/media/834/stream" {
		t.Fatalf("the remote stream the listener picked moved to %d %q", chosen.LocationID, chosen.StreamURL)
	}
	if len(resolved.Works) != 1 || resolved.Works[0].ID != 801 || resolved.Works[0].Title != "Example Work" || resolved.Works[0].PrimaryCode != "RJ00000000" {
		t.Fatalf("works = %#v", resolved.Works)
	}
}

func TestResolvePlaybackQueueNeverPlaysAnOfflineLibraryFile(t *testing.T) {
	db := openMigratedTestDB(t)
	user := seedPlaybackQueueWork(t, db)
	server := NewServer(db, config.Config{DataRoot: filepath.Join(t.TempDir(), "unmounted")})

	resolved := resolveQueue(t, server, user, `{"items":[
		{"mediaItemId":821,"workId":801,"locationId":831},
		{"mediaItemId":822,"workId":801,"locationId":833}
	],"titlesOnly":true}`)
	if resolved.Items[0].Status != playbackQueueItemUnavailable {
		t.Fatalf("a local-only track on an unmounted library = %s, want unavailable", resolved.Items[0].Status)
	}
	if track := resolved.Items[1].Track; track == nil || track.LocationID != 832 {
		t.Fatalf("a track with a cached copy of an offline file plays from %#v, want the cache", track)
	}
	if len(resolved.Works) != 0 {
		t.Fatalf("a titles-only resolve loaded works: %#v", resolved.Works)
	}
}

func TestWorkResumeQueueFollowsTheDirectoryOrderAndTheCursorLocation(t *testing.T) {
	db := openMigratedTestDB(t)
	user := seedPlaybackQueueWork(t, db)
	if _, err := db.Exec(`
		INSERT INTO user_work_playback_cursor (user_id, work_id, media_item_id, file_source_id, location_id, location_type, position_seconds, completed)
		VALUES (?, 801, 822, 811, 832, 'cache', 42, 0)
	`, user.ID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: t.TempDir()})

	request := httptest.NewRequest(http.MethodGet, "/api/works/801/resume-queue", nil)
	request.SetPathValue("id", "801")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response := httptest.NewRecorder()
	server.getWorkResumeQueue(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Resume *workResumeQueue `json:"resume"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	resume := body.Resume
	if resume == nil {
		t.Fatal("resume = null")
	}
	order := []string{}
	for _, track := range resume.Tracks {
		order = append(order, track.FolderPath+"/"+track.Title)
	}
	// Folders come before files and names compare by their numbers; the
	// missing file never queues.
	if got := strings.Join(order, " | "); got != "Extra/Bonus/bonus.mp3 | Main/track 2.mp3 | Main/track 10.mp3" {
		t.Fatalf("resume order = %s", got)
	}
	if resume.StartIndex != 1 || resume.PositionSeconds != 42 {
		t.Fatalf("start = %d at %v, want the cursor's track at 42", resume.StartIndex, resume.PositionSeconds)
	}
	if start := resume.Tracks[1]; start.LocationID != 832 || start.LocationType != "cache" {
		t.Fatalf("Resume continues on %d %s, want the cursor's cached copy", start.LocationID, start.LocationType)
	}
	if resume.Work.ID != 801 || resume.Work.Title != "Example Work" {
		t.Fatalf("work = %#v", resume.Work)
	}
}
