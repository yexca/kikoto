package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

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

func TestLoadVoiceSummariesCountsPlayableWorksAsAvailabilityUnion(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Example Work 1'), (2, 'RJ00000002', 'Example Work 2')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test'), (2, 1, 'voice_actor', 'test')",
		"INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (11, 'example_local', 'Example Local', 'local_scan', 10, 1), (12, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 20, 1)",
		"INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Example Track')",
		"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 11, 'local', 'Library/RJ00000001/track.mp3', 'available'), (2, 1, 12, 'cache', 'cache/RJ00000001/track.mp3', 'available'), (3, 1, 12, 'remote_stream', 'remote/RJ00000001/track.mp3', 'available')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	summaries, err := (&Server{db: db}).loadVoiceSummaries(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 {
		t.Fatalf("summaries = %+v, want one voice", summaries)
	}
	summary := summaries[0]
	if summary.KnownWorks != 2 || summary.LocalWorks != 1 || summary.CachedWorks != 1 || summary.RemoteWorks != 1 || summary.PlayableWorks != 1 {
		t.Fatalf("summary = %+v, want known 2 and one distinct playable work across local, cache, and remote", summary)
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

func TestLoadVoiceAliasCandidatesAttachesAliasesAfterReleasingCursor(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO person (id, display_name) VALUES (1, 'Example Voice A'), (2, 'Example Voice B'), (3, 'Example Voice C')",
		`INSERT INTO person_alias (person_id, alias, source) VALUES
			(1, 'Target Alias', 'manual'),
			(2, 'Zeta Alias', 'manual'),
			(2, 'Example Voice B', 'primary_name'),
			(2, 'Alpha Alias', 'manual')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	// The single test connection turns a nested query under the open candidate
	// cursor into a deadline failure instead of a hang.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	candidates, err := (&Server{db: db}).loadVoiceAliasCandidates(ctx, 1, "")
	if err != nil {
		t.Fatalf("load alias candidates: %v", err)
	}
	aliasesByPerson := map[int64][]string{}
	for _, candidate := range candidates {
		if candidate.Aliases == nil {
			t.Fatalf("candidate %d aliases = nil, want an empty list", candidate.PersonID)
		}
		names := []string{}
		for _, alias := range candidate.Aliases {
			names = append(names, alias.Alias)
		}
		aliasesByPerson[candidate.PersonID] = names
	}
	want := map[int64][]string{
		2: {"Example Voice B", "Alpha Alias", "Zeta Alias"},
		3: {},
	}
	if !reflect.DeepEqual(aliasesByPerson, want) {
		t.Fatalf("candidate aliases = %#v, want %#v", aliasesByPerson, want)
	}
}

// Regression: the merged-away name stays a confirmed alias of the target, and
// the startup snapshot projection must resolve it instead of recreating the
// source person and splitting its credits again.
func TestVoiceSnapshotSyncKeepsMergedPersonMerged(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Voice work')",
		`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
			SELECT 1, id, 'RJ00000001', '{"workno":"RJ00000001","creaters":{"voice_by":[{"name":"Source Voice"}]}}'
			FROM metadata_provider WHERE code = 'dlsite'`,
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Target Voice', 'target voice')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := &Server{db: db}
	ctx := context.Background()
	if err := server.syncVoiceCreditsFromSnapshots(ctx); err != nil {
		t.Fatal(err)
	}
	var sourceID int64
	if err := db.QueryRow("SELECT id FROM person WHERE display_name = 'Source Voice'").Scan(&sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.mergeVoicePeople(ctx, 1, sourceID); err != nil {
		t.Fatal(err)
	}

	if err := server.syncVoiceCreditsFromSnapshots(ctx); err != nil {
		t.Fatal(err)
	}
	var people int
	if err := db.QueryRow("SELECT COUNT(*) FROM person WHERE display_name = 'Source Voice'").Scan(&people); err != nil {
		t.Fatal(err)
	}
	var creditedPeople []int64
	rows, err := db.Query("SELECT person_id FROM work_credit WHERE work_id = 1 AND role = 'voice_actor' ORDER BY person_id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		creditedPeople = append(creditedPeople, id)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if people != 0 || !reflect.DeepEqual(creditedPeople, []int64{1}) {
		t.Fatalf("after re-sync: recreated people = %d, credited people = %v, want 0 and [1]", people, creditedPeople)
	}
}

// A provider voice actor id moves with the merge, so the next sync reporting
// it neither recreates the source nor renames the target back to the merged
// name. Undo returns the id to the restored person.
func TestVoiceMergeMovesProviderIdentityAndUndoRestoresIt(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO metadata_provider (id, code, display_name) VALUES (11, 'kikoeru_source_example_remote', 'Example Remote')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Target Voice', 'target voice'), (2, 'Source Voice', 'source voice')",
		"INSERT INTO person_alias (person_id, alias, source) VALUES (1, 'Target Voice', 'primary_name'), (2, 'Source Voice', 'primary_name')",
		"INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary) VALUES (2, 11, 'voice_actor_id', 'voice-0001', 1)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := &Server{db: db}
	ctx := context.Background()
	merged, err := server.mergeVoicePeople(ctx, 1, 2)
	if err != nil {
		t.Fatal(err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	personID, err := upsertPersonIdentity(ctx, tx, "Source Voice", sql.NullInt64{Int64: 11, Valid: true}, "voice-0001")
	if err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var targetName string
	if err := db.QueryRow("SELECT display_name FROM person WHERE id = 1").Scan(&targetName); err != nil {
		t.Fatal(err)
	}
	if personID != 1 || targetName != "Target Voice" {
		t.Fatalf("identity resolved to person %d named %q, want person 1 named Target Voice", personID, targetName)
	}

	if _, err := server.undoVoiceMerge(ctx, 1, merged["mergeId"].(int64)); err != nil {
		t.Fatal(err)
	}
	var owner int64
	if err := db.QueryRow("SELECT person_id FROM person_external_id WHERE provider_id = 11 AND external_id = 'voice-0001'").Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != 2 {
		t.Fatalf("external id owner after undo = %d, want restored person 2", owner)
	}
}
