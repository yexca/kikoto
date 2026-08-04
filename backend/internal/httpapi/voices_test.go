package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestSearchVoiceRemoteSourcesUsesPreferredMetadataLanguageAndPreservesTags(t *testing.T) {
	tags := []kikoeru.Tag{
		{Name: "中文标签", I18n: map[string]kikoeru.LocalizedTag{"ja-jp": {Name: "日本語タグ"}}},
		{Name: "Tag 2"},
		{Name: "Tag 3"},
		{Name: "Tag 4"},
		{Name: "Tag 5"},
		{Name: "Tag 6"},
		{Name: "Tag 7"},
		{Name: "Tag 8"},
		{Name: "Tag 9"},
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.URL.Path, "/api/search/") {
			http.NotFound(w, request)
			return
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{
			Works: []kikoeru.Work{{
				ID: 1, SourceID: "RJ00000001", Title: "Remote voice work", Tags: tags,
			}},
			Pagination: kikoeru.Pagination{Page: 1, PageSize: voiceRemotePageSize, TotalCount: 1},
		})
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	statements := []struct {
		query string
		args  []any
	}{
		{query: `INSERT INTO person (id, display_name) VALUES (1, 'Example voice')`},
		{query: `INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 10, 1)`},
		{query: `INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (11, ?, ?)`, args: []any{remote.URL, remote.URL}},
		{query: `INSERT INTO app_setting (key, value_json) VALUES ('dlsite_metadata_language', '"ja-jp"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`},
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	server := NewServer(db, config.Config{})
	results, err := server.searchVoiceRemoteSources(context.Background(), 1, "Example voice")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Status != "ok" || len(results[0].Works) != 1 {
		t.Fatalf("remote results = %+v, want one successful source with one work", results)
	}
	projectedTags := results[0].Works[0].Tags
	if len(projectedTags) != len(tags) {
		t.Fatalf("tags = %v, want all %d remote tags", projectedTags, len(tags))
	}
	if projectedTags[0] != "日本語タグ" || projectedTags[len(projectedTags)-1] != "Tag 9" {
		t.Fatalf("tags = %v, want Japanese localization without truncation", projectedTags)
	}
}

func TestLoadVoiceSummariesSerializesMissingUserTagsAsArray(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Voice work')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	summaries, err := server.loadVoiceSummaries(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 || summaries[0].UserTags == nil {
		t.Fatalf("summaries = %+v, want one voice with non-nil userTags", summaries)
	}
	raw, err := json.Marshal(summaries)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"userTags":[]`) {
		t.Fatalf("JSON = %s, want empty userTags array", raw)
	}
}

func TestLoadVoiceKnownWorksProjectsAvailableSourcePresenceWithoutMediaLocation(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'SYNTH-VOICE-01', 'Presence-only voice work')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test')",
		"INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 10, 1)",
		"INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability) VALUES (1, 11, 'source', 'SYNTH-VOICE-REMOTE-01', 'available')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	works, err := server.loadVoiceKnownWorks(context.Background(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 1 {
		t.Fatalf("works = %+v, want one known work", works)
	}
	if !works[0].Remote {
		t.Fatalf("work = %+v, want remote availability from work_source_presence", works[0])
	}
	tag, ok := voiceSourceTagForID(works[0].SourceTags, 11)
	if !ok {
		t.Fatalf("sourceTags = %+v, want Example Remote source tag", works[0].SourceTags)
	}
	if tag.Status != "available" || tag.Count != 1 {
		t.Fatalf("source tag = %+v, want available presence count 1", tag)
	}
	observation, ok := voiceRemoteObservationForSource(works[0].RemoteObservations, 11)
	if !ok || observation.RemoteCode != "SYNTH-VOICE-REMOTE-01" || observation.Status != "available" {
		t.Fatalf("remote observation = %+v (present %t), want exact persisted source code", observation, ok)
	}
	var locationCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM media_file_location").Scan(&locationCount); err != nil {
		t.Fatal(err)
	}
	if locationCount != 0 {
		t.Fatalf("media location count = %d, want 0 for presence-only regression", locationCount)
	}
}

func TestLoadVoiceKnownWorksProjectsExactRemoteCodeForEveryPersistedSource(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'SYNTH-VOICE-04', 'Multi-source voice work')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test')",
		"INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (11, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 10, 1)",
		"INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (12, 'example_remote_b', 'Example Remote B', 'kikoeru_compatible', 20, 1)",
		"INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability) VALUES (1, 11, 'source', 'EXACT-REMOTE-A', 'available')",
		"INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability) VALUES (1, 12, 'source', 'EXACT-REMOTE-B', 'available')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	works, err := server.loadVoiceKnownWorks(context.Background(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 1 || len(works[0].RemoteObservations) != 2 {
		t.Fatalf("works = %+v, want two persisted remote observations", works)
	}
	for sourceID, remoteCode := range map[int64]string{11: "EXACT-REMOTE-A", 12: "EXACT-REMOTE-B"} {
		observation, ok := voiceRemoteObservationForSource(works[0].RemoteObservations, sourceID)
		if !ok || observation.RemoteCode != remoteCode || observation.Status != "available" {
			t.Fatalf("source %d observation = %+v (present %t), want remoteCode %q", sourceID, observation, ok, remoteCode)
		}
	}
}

func TestLoadVoiceKnownWorksKeepsNoObservationDistinctFromNotFound(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'SYNTH-VOICE-02', 'Observed missing voice work')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test')",
		"INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (11, 'observed_remote', 'Observed Remote', 'kikoeru_compatible', 10, 1)",
		"INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (12, 'unchecked_remote', 'Unchecked Remote', 'kikoeru_compatible', 20, 1)",
		"INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability) VALUES (1, 11, 'source', 'SYNTH-VOICE-02', 'missing')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	works, err := server.loadVoiceKnownWorks(context.Background(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 1 {
		t.Fatalf("works = %+v, want one known work", works)
	}
	if works[0].Remote {
		t.Fatalf("work = %+v, observed not-found source must not be remote-available", works[0])
	}
	observed, ok := voiceSourceTagForID(works[0].SourceTags, 11)
	if !ok || observed.Status != "not_found" || observed.Count != 0 {
		t.Fatalf("observed source = %+v (present %t), want not_found with zero available count", observed, ok)
	}
	if unchecked, ok := voiceSourceTagForID(works[0].SourceTags, 12); ok {
		t.Fatalf("unchecked source = %+v, want no synthetic observation", unchecked)
	}
}

func TestLoadVoiceKnownWorksPrefersConcreteAvailableLocationOverStaleNegativePresence(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'SYNTH-VOICE-03', 'Concrete remote voice work')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test')",
		"INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 10, 1)",
		"INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability) VALUES (1, 11, 'source', 'SYNTH-VOICE-03', 'unavailable')",
		"INSERT INTO media_item (id, work_id, kind, title) VALUES (21, 1, 'audio', 'Track 1')",
		"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, stream_url, availability) VALUES (31, 21, 11, 'remote_stream', '/stream/31', 'available')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	works, err := server.loadVoiceKnownWorks(context.Background(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 1 || !works[0].Remote {
		t.Fatalf("works = %+v, want one remote-available work", works)
	}
	tag, ok := voiceSourceTagForID(works[0].SourceTags, 11)
	if !ok || tag.Status != "available" || tag.Count != 1 {
		t.Fatalf("source tag = %+v (present %t), want concrete available location to win", tag, ok)
	}
}

func voiceSourceTagForID(tags []circleSourceStat, sourceID int64) (circleSourceStat, bool) {
	for _, tag := range tags {
		if tag.SourceID != nil && *tag.SourceID == sourceID && tag.Key != "cache" {
			return tag, true
		}
	}
	return circleSourceStat{}, false
}

func voiceRemoteObservationForSource(observations []voiceRemoteObservation, sourceID int64) (voiceRemoteObservation, bool) {
	for _, observation := range observations {
		if observation.SourceID == sourceID {
			return observation, true
		}
	}
	return voiceRemoteObservation{}, false
}
