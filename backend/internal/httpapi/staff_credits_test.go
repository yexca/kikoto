package httpapi

import (
	"context"
	"reflect"
	"testing"
)

// The snapshot projection stores a work's staff credits with their DLsite
// creator ids, binds each voice actor to its DLsite id without replacing the
// existing person, and follows a later snapshot that drops a credit or renames
// the voice actor.
func TestSnapshotProjectionStoresStaffCreditsAndVoiceActorIDs(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	for _, statement := range []string{
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`,
		// A voice actor credited before the projection stored DLsite ids.
		`INSERT INTO person (id, display_name, sort_name) VALUES (7, 'Example Voice', 'example voice')`,
		`INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 7, 'voice_actor', 'metadata_snapshot')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	insertProjectionSnapshot(t, db, 1, "2000-01-01 00:00:00", `{"workno":"RJ00000000","creaters":{
		"created_by":[{"id":"100","name":"Example Author","classification":"created_by"}],
		"scenario_by":[{"id":"101","name":"Example Writer","classification":"scenario_by"}],
		"illust_by":[{"id":"102","name":"Example Artist B","classification":"illust_by"},{"id":"103","name":"Example Artist A","classification":"illust_by"}],
		"voice_by":[{"id":"200","name":"Example Voice","classification":"voice_by"}]}}`)
	server := &Server{db: db}
	if err := server.projectChangedSnapshots(ctx); err != nil {
		t.Fatal(err)
	}

	type storedCredit struct{ Role, Name, ExternalID string }
	storedCredits := func() []storedCredit {
		t.Helper()
		rows, err := db.Query(`SELECT role, name, external_id FROM work_staff_credit WHERE work_id = 1 ORDER BY position`)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		credits := []storedCredit{}
		for rows.Next() {
			var credit storedCredit
			if err := rows.Scan(&credit.Role, &credit.Name, &credit.ExternalID); err != nil {
				t.Fatal(err)
			}
			credits = append(credits, credit)
		}
		return credits
	}
	want := []storedCredit{
		{"author", "Example Author", "100"},
		{"scenario", "Example Writer", "101"},
		{"illustration", "Example Artist B", "102"},
		{"illustration", "Example Artist A", "103"},
	}
	if got := storedCredits(); !reflect.DeepEqual(got, want) {
		t.Fatalf("staff credits = %#v, want %#v", got, want)
	}
	var boundPerson int64
	if err := db.QueryRow(`
		SELECT external.person_id FROM person_external_id AS external
		INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
		WHERE provider.code = 'dlsite' AND external.id_type = 'voice_actor_id' AND external.external_id = '200'
	`).Scan(&boundPerson); err != nil {
		t.Fatal(err)
	}
	if boundPerson != 7 {
		t.Fatalf("DLsite voice actor id bound to person %d, want the existing person 7", boundPerson)
	}

	// The next snapshot no longer credits the artists, and DLsite renamed the
	// voice actor under the same creator id.
	insertProjectionSnapshot(t, db, 1, "2000-02-02 00:00:00", `{"workno":"RJ00000000","creaters":{
		"created_by":[{"id":"100","name":"Example Author","classification":"created_by"}],
		"scenario_by":[{"id":"101","name":"Example Writer","classification":"scenario_by"}],
		"voice_by":[{"id":"200","name":"Example Voice Renamed","classification":"voice_by"}]}}`)
	if err := server.projectChangedSnapshots(ctx); err != nil {
		t.Fatal(err)
	}
	if got := storedCredits(); !reflect.DeepEqual(got, want[:2]) {
		t.Fatalf("staff credits after the artists were dropped = %#v, want %#v", got, want[:2])
	}
	var people int
	var name string
	if err := db.QueryRow(`SELECT COUNT(*), MAX(display_name) FROM person`).Scan(&people, &name); err != nil {
		t.Fatal(err)
	}
	if people != 1 || name != "Example Voice Renamed" {
		t.Fatalf("people after a DLsite rename = %d named %q, want the one person renamed", people, name)
	}

	detail, err := server.loadWorkStaffCredits(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if wantDetail := []staffCredit{{"author", "Example Author"}, {"scenario", "Example Writer"}}; !reflect.DeepEqual(detail, wantDetail) {
		t.Fatalf("detail staff credits = %#v, want %#v", detail, wantDetail)
	}
}
