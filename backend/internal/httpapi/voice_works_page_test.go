package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func TestKnownVoiceWorkViewKeepsIdentityWithItsRemoteObservations(t *testing.T) {
	known := voiceKnownWork{WorkID: 11, PrimaryCode: "RJ00000001", Title: "Example Work 1"}
	matches := []voiceRemoteWork{
		voiceCatalogRemoteWorkForTest("rj00000001", "RJ00000001", "available"),
		voiceCatalogRemoteWorkForTest("rj00000001", "RJ00000002", "available"),
	}

	merged := knownVoiceWorkView(known, matches).Known
	if merged == nil || merged.WorkID != 11 {
		t.Fatalf("view = %+v, want the known work", merged)
	}
	if merged.Remote {
		t.Fatalf("remote = true, want the known work's own availability flag untouched")
	}
	tag, ok := voiceSourceTagForID(merged.SourceTags, 7)
	if !ok || tag.Status != "available" || tag.Count != 1 {
		t.Fatalf("source tag = %+v (present %t), want an available tag for the observed source", tag, ok)
	}
	if got := voiceObservationCodes(merged.RemoteObservations); !reflect.DeepEqual(got, []string{"RJ00000001", "RJ00000002"}) {
		t.Fatalf("observations = %v, want the canonical edition first", got)
	}

	known.RemoteCode = "RJ00000002"
	merged = knownVoiceWorkView(known, matches).Known
	if got := voiceObservationCodes(merged.RemoteObservations); !reflect.DeepEqual(got, []string{"RJ00000002", "RJ00000001"}) {
		t.Fatalf("observations = %v, want the known exact edition first", got)
	}
}

func TestKnownVoiceWorkViewKeepsPersistedObservationWithoutCatalogRows(t *testing.T) {
	known := voiceKnownWork{
		WorkID: 11, PrimaryCode: "RJ00000001",
		RemoteObservations: []voiceRemoteObservation{
			{SourceID: 9, SourceCode: "example_remote_b", SourceName: "Example Remote B", RemoteCode: "RJ00000003", Status: "available"},
		},
	}
	observations := knownVoiceWorkView(known, nil).Known.RemoteObservations
	if len(observations) != 1 || observations[0].SourceID != 9 || observations[0].RemoteCode != "RJ00000003" || observations[0].Status != "available" {
		t.Fatalf("observations = %+v, want the persisted exact source route", observations)
	}
}

func TestRemoteVoiceWorkViewDescribesOneWorkAcrossSources(t *testing.T) {
	missing := voiceCatalogRemoteWorkForTest("RJ00000004", "RJ00000004", "not_found")
	other := missing
	other.SourceID, other.SourceCode, other.SourceName = 8, "example_remote_b", "Example Remote B"

	view := remoteVoiceWorkView([]voiceRemoteWork{missing, other})
	if view.Remote == nil || view.Remote.SourceID != 7 {
		t.Fatalf("view = %+v, want the work described by its first catalog row", view)
	}
	if len(view.RemoteObservations) != 2 || view.RemoteObservations[0].Status != "not_found" {
		t.Fatalf("observations = %+v, want one negative observation per source", view.RemoteObservations)
	}
}

func TestVoiceWorksPageFiltersAndOrdersInSQL(t *testing.T) {
	server := voiceWorksPageFixture(t)
	codes := func(query voiceWorksQuery) []string {
		t.Helper()
		query.Page, query.PageSize = 1, 24
		page, err := server.loadVoiceWorksPage(context.Background(), 1, 1, query)
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != len(page.Works) {
			t.Fatalf("total = %d with %d works on one page", page.Total, len(page.Works))
		}
		return voiceWorkViewCodes(page.Works)
	}
	for _, test := range []struct {
		availability, query string
		want                []string
	}{
		{"all", "", []string{"RJ00000001", "RJ00000002", "RJ00000003", "RJ00000004", "RJ00000005"}},
		{"available", "", []string{"RJ00000001", "RJ00000004", "RJ00000005"}},
		{"local", "", []string{"RJ00000001"}},
		{"remote", "", []string{"RJ00000005"}},
		// A source that failed, or was never checked, is not a missing work.
		{"missing", "", []string{"RJ00000002"}},
		// The search reads the Library search document, personal tags, and the catalog row.
		{"all", "gamma", []string{"RJ00000003"}},
		{"all", "example tag", []string{"RJ00000004"}},
		{"all", "rj00000005", []string{"RJ00000005"}},
		{"all", "catalog tag", []string{"RJ00000005"}},
		{"local", "epsilon", []string{}},
	} {
		got := codes(voiceWorksQuery{Availability: test.availability, Query: test.query, Sort: "code", Direction: "asc"})
		if !reflect.DeepEqual(got, test.want) {
			t.Errorf("availability %q query %q = %v, want %v", test.availability, test.query, got, test.want)
		}
	}
	// The catalog-only work has no release date, rating, or sales count, and
	// stays last in either direction.
	for _, test := range []struct {
		sort, direction string
		want            []string
	}{
		{"code", "desc", []string{"RJ00000005", "RJ00000004", "RJ00000003", "RJ00000002", "RJ00000001"}},
		{"title", "asc", []string{"RJ00000002", "RJ00000001", "RJ00000005", "RJ00000004", "RJ00000003"}},
		{"sales", "desc", []string{"RJ00000001", "RJ00000003", "RJ00000002", "RJ00000004", "RJ00000005"}},
		{"release", "desc", []string{"RJ00000001", "RJ00000003", "RJ00000002", "RJ00000004", "RJ00000005"}},
		{"release", "asc", []string{"RJ00000004", "RJ00000002", "RJ00000003", "RJ00000001", "RJ00000005"}},
		{"rating", "desc", []string{"RJ00000002", "RJ00000003", "RJ00000001", "RJ00000004", "RJ00000005"}},
		{"rating", "asc", []string{"RJ00000004", "RJ00000001", "RJ00000003", "RJ00000002", "RJ00000005"}},
	} {
		got := codes(voiceWorksQuery{Availability: "all", Sort: test.sort, Direction: test.direction})
		if !reflect.DeepEqual(got, test.want) {
			t.Errorf("sort %s %s = %v, want %v", test.sort, test.direction, got, test.want)
		}
	}
}

func TestVoiceWorksPagePagesOneLogicalWorkPerEditionFamily(t *testing.T) {
	db := openMigratedTestDB(t)
	execVoiceWorksFixture(t, db,
		"INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')",
		// Works 1 and 2 are the origin and a translation of one logical work.
		"INSERT INTO work (id, primary_code, title, release_date) VALUES (1, 'RJ00000001', 'Example Work 1', '2024-01-01'), (2, 'RJ00000002', 'Example Work 1 translated', '2024-06-01'), (3, 'RJ00000003', 'Example Work 3', '2024-03-01')",
		"INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000001')",
		"INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES (1, 1, 'RJ00000001', 'RJ00000001', 1), (2, 1, 'RJ00000002', 'RJ00000001', 0)",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test'), (2, 1, 'voice_actor', 'test'), (3, 1, 'voice_actor', 'test')",
		"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (10, 'example_local', 'Example Local', 'local_scan', 1)",
		// Only the translation has a local copy.
		"INSERT INTO media_item (id, work_id, kind, title) VALUES (21, 2, 'audio', 'Track 1')",
		"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (31, 21, 10, 'local', 'RJ00000002/track.mp3', 'available')",
	)
	server := NewServer(db, config.Config{})

	first, err := server.loadVoiceWorksPage(context.Background(), 0, 1, voiceWorksQuery{Page: 1, PageSize: 1, Availability: "all"})
	if err != nil {
		t.Fatal(err)
	}
	// The family is ordered by its newest edition and counted once.
	if first.Total != 2 || len(first.Works) != 1 || first.Works[0].Known == nil || first.Works[0].Known.PrimaryCode != "RJ00000001" || !first.Works[0].Known.Local {
		t.Fatalf("first page = %+v, want the one logical work with its translation's local copy", first)
	}
	second, err := server.loadVoiceWorksPage(context.Background(), 0, 1, voiceWorksQuery{Page: 2, PageSize: 1, Availability: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if second.Page != 2 || !reflect.DeepEqual(voiceWorkViewCodes(second.Works), []string{"RJ00000003"}) {
		t.Fatalf("second page = %+v, want the other work", second)
	}
	local, err := server.loadVoiceWorksPage(context.Background(), 0, 1, voiceWorksQuery{Page: 1, PageSize: 24, Availability: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if local.Total != 1 || !reflect.DeepEqual(voiceWorkViewCodes(local.Works), []string{"RJ00000001"}) {
		t.Fatalf("local works = %+v, want the family holding a local edition", local)
	}
}

func TestVoiceWorksEndpointPagesKnownAndRemoteCatalogWorks(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')",
		"INSERT INTO work (id, primary_code, title, release_date) VALUES (1, 'RJ00000001', 'Example Work 1', '2024-01-01')",
		"INSERT INTO work (id, primary_code, title, release_date) VALUES (2, 'RJ00000002', 'Example Work 2', '2024-02-01')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (2, 1, 'voice_actor', 'test')",
		"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (11, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1)",
		"INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (11, 'https://source.example.invalid', 'https://source.example.invalid/api')",
		`INSERT INTO app_setting (key, value_json) VALUES ('anonymous_access_enabled', 'true')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	source := remoteSourceForUse{ID: 11, Code: "example_remote_a", DisplayName: "Example Remote A", Enabled: true, SourceType: sourceTypeKikoeruCompatible}
	candidate := func(code, title, releaseDate string) voiceCatalogCandidate {
		return voiceCatalogCandidate{
			CanonicalCode: code, RemoteCode: code, RawJSON: "{}",
			Projection: remoteCatalogWorkProjection{
				RemoteID: code, RemoteCode: code, Title: title, ReleaseDate: releaseDate, Tags: []string{}, VoiceActors: []string{},
			},
		}
	}
	if _, err := server.persistVoiceCatalogSource(context.Background(), 1, 1, voiceCatalogSourceResult{
		Source: source, Complete: true,
		Candidates: []voiceCatalogCandidate{
			// One catalog row matches a known work and two are remote-only.
			candidate("RJ00000002", "Example Work 2", "2024-02-01"),
			candidate("RJ00000003", "Example Work 3", "2024-03-01"),
			candidate("RJ00000004", "Example Work 4", "2024-04-01"),
		},
	}, true); err != nil {
		t.Fatal(err)
	}

	type pageWork struct {
		PrimaryCode        string                   `json:"primaryCode"`
		Local              *bool                    `json:"local"`
		SourceID           *int64                   `json:"sourceId"`
		RemoteObservations []voiceRemoteObservation `json:"remoteObservations"`
	}
	type worksPage struct {
		Works    []pageWork `json:"works"`
		Page     int        `json:"page"`
		PageSize int        `json:"pageSize"`
		Total    int        `json:"total"`
	}
	get := func(target string, into any) {
		t.Helper()
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, body = %s", target, response.Code, response.Body.String())
		}
		if err := json.Unmarshal(response.Body.Bytes(), into); err != nil {
			t.Fatal(err)
		}
	}
	codes := func(page worksPage) []string {
		result := []string{}
		for _, work := range page.Works {
			result = append(result, work.PrimaryCode)
		}
		return result
	}

	var first worksPage
	get("/api/voices/1/works?page=1&pageSize=3", &first)
	if first.Total != 4 || first.Page != 1 || first.PageSize != 3 {
		t.Fatalf("first page = %+v, want 4 works paged by 3", first)
	}
	if got := codes(first); !reflect.DeepEqual(got, []string{"RJ00000004", "RJ00000003", "RJ00000002"}) {
		t.Fatalf("first page codes = %v, want newest release first across known and remote works", got)
	}
	remoteOnly, merged := first.Works[0], first.Works[2]
	if remoteOnly.Local != nil || remoteOnly.SourceID == nil || *remoteOnly.SourceID != 11 || len(remoteOnly.RemoteObservations) != 1 {
		t.Fatalf("remote-only work = %+v, want the remote catalog shape with its observation", remoteOnly)
	}
	if merged.Local == nil || merged.SourceID != nil || len(merged.RemoteObservations) != 1 {
		t.Fatalf("merged work = %+v, want the known shape carrying the catalog observation", merged)
	}

	// A page past the end resolves to the last page.
	var last worksPage
	get("/api/voices/1/works?page=9&pageSize=3&sort=release", &last)
	if last.Page != 2 || !reflect.DeepEqual(codes(last), []string{"RJ00000001"}) {
		t.Fatalf("last page = %+v, want page 2 with the oldest work", last)
	}

	var filtered worksPage
	get("/api/voices/1/works?availability=remote&sort=code&direction=asc&q=example+work", &filtered)
	if filtered.Total != 3 || filtered.PageSize != 24 || !reflect.DeepEqual(codes(filtered), []string{"RJ00000002", "RJ00000003", "RJ00000004"}) {
		t.Fatalf("filtered page = %+v, want the three works the source holds in code order", filtered)
	}

	var matches struct {
		RemoteMatches []voiceRemoteSourceSet `json:"remoteMatches"`
	}
	get("/api/voices/1/remote-matches?includeWorks=false", &matches)
	if len(matches.RemoteMatches) != 1 || matches.RemoteMatches[0].Total != 3 || len(matches.RemoteMatches[0].Works) != 0 {
		t.Fatalf("remote matches = %+v, want the source state and total without its works", matches.RemoteMatches)
	}
}

// voiceWorksPageFixture builds one voice actor with four credited works and
// one catalog-only work:
//
//	RJ00000001 Beta     local copy
//	RJ00000002 alpha    reported absent by the remote source
//	RJ00000003 Gamma    remote source check failed
//	RJ00000004 Epsilon  cached copy, personal tag "Example Tag"
//	RJ00000005 Delta    remote catalog only, without release date, rating, or sales
func voiceWorksPageFixture(t *testing.T) *Server {
	t.Helper()
	db := openMigratedTestDB(t)
	execVoiceWorksFixture(t, db,
		"INSERT INTO user_account (id, username, role) VALUES (1, 'synthetic-user', 'user')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')",
		`INSERT INTO work (id, primary_code, title, release_date, rating_average, sales_count) VALUES
			(1, 'RJ00000001', 'Beta', '2024-03-01', 4.1, 300),
			(2, 'RJ00000002', 'alpha', '2024-01-01', 4.9, 100),
			(3, 'RJ00000003', 'Gamma', '2024-02-01', 4.5, 200),
			(4, 'RJ00000004', 'Epsilon', '2023-12-01', 3.0, 50)`,
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test'), (2, 1, 'voice_actor', 'test'), (3, 1, 'voice_actor', 'test'), (4, 1, 'voice_actor', 'test')",
		"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (10, 'example_local', 'Example Local', 'local_scan', 1), (11, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1)",
		"INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (11, 'https://source.example.invalid', 'https://source.example.invalid/api')",
		"INSERT INTO media_item (id, work_id, kind, title) VALUES (21, 1, 'audio', 'Track 1'), (24, 4, 'audio', 'Track 1')",
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(31, 21, 10, 'local', 'RJ00000001/track.mp3', 'available'),
			(34, 24, 11, 'cache', 'cache/RJ00000004/track.mp3', 'available')`,
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability) VALUES
			(2, 11, 'source', 'RJ00000002', 'not_found'),
			(3, 11, 'source', 'RJ00000003', 'error')`,
		"INSERT INTO user_tag (id, user_id, name) VALUES (1, 1, 'Example Tag')",
		"INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (1, 4, 1)",
	)
	server := NewServer(db, config.Config{})
	source := remoteSourceForUse{ID: 11, Code: "example_remote_a", DisplayName: "Example Remote A", Enabled: true, SourceType: sourceTypeKikoeruCompatible}
	if _, err := server.persistVoiceCatalogSource(context.Background(), 1, 1, voiceCatalogSourceResult{
		Source: source, Complete: true,
		Candidates: []voiceCatalogCandidate{{
			CanonicalCode: "RJ00000005", RemoteCode: "RJ00000005", RawJSON: "{}",
			Projection: remoteCatalogWorkProjection{
				RemoteID: "RJ00000005", RemoteCode: "RJ00000005", Title: "Delta", Tags: []string{"Catalog Tag"}, VoiceActors: []string{},
			},
		}},
	}, true); err != nil {
		t.Fatal(err)
	}
	return server
}

func execVoiceWorksFixture(t *testing.T, db *sqlutil.DB, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("%v: %s", err, statement)
		}
	}
}

func voiceCatalogRemoteWorkForTest(primaryCode, remoteCode, availability string) voiceRemoteWork {
	return voiceRemoteWork{
		SourceID: 7, SourceCode: "example_remote_a", SourceName: "Example Remote A",
		PrimaryCode: primaryCode, RemoteCode: remoteCode, Title: "Example Work",
		RemotePlayable: availability == "available", HasRemote: availability == "available", Availability: availability,
	}
}

func voiceObservationCodes(observations []voiceRemoteObservation) []string {
	codes := []string{}
	for _, observation := range observations {
		codes = append(codes, observation.RemoteCode)
	}
	return codes
}

func voiceWorkViewCodes(views []voiceWorkView) []string {
	codes := []string{}
	for _, view := range views {
		if view.Known != nil {
			codes = append(codes, view.Known.PrimaryCode)
		} else {
			codes = append(codes, view.Remote.PrimaryCode)
		}
	}
	return codes
}
