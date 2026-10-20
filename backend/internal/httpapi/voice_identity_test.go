package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"reflect"
	"testing"
)

// Fetching a work stores its DLsite snapshot and, moments later, a remote
// source's snapshot of the same work. The remote snapshot is the work's latest,
// yet the voice actor it credits is the DLsite creator the DLsite snapshot
// names, so the next projection gives that person the DLsite id beside the
// remote one, without a second person, and a remote snapshot naming no voice
// actor does not credit the work to the unknown voice actor.
func TestVoiceCreditProjectionTakesDLsiteIDsBehindNewerRemoteSnapshot(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work'), (2, 'RJ00000001', 'Example Work 2')`); err != nil {
		t.Fatal(err)
	}
	var remoteProviderID int64
	if err := db.QueryRow(`INSERT INTO metadata_provider (code, display_name) VALUES ('test_remote_metadata', 'Test remote metadata') RETURNING id`).Scan(&remoteProviderID); err != nil {
		t.Fatal(err)
	}
	insertProjectionSnapshot(t, db, 1, "2000-01-01 00:00:00", `{"workno":"RJ00000000","creaters":{"voice_by":[{"id":"100","name":"Example Voice A","classification":"voice_by"}]}}`)
	insertProjectionSnapshot(t, db, 2, "2000-01-01 00:00:00", `{"workno":"RJ00000001","creaters":{"voice_by":[{"id":"101","name":"Example Voice B","classification":"voice_by"}]}}`)
	remote := map[int64]string{
		1: `{"source_id":"RJ00000000","vas":[{"id":"va-1","name":"Example Voice A"}]}`,
		2: `{"source_id":"RJ00000001","vas":[]}`,
	}
	for _, workID := range []int64{1, 2} {
		var snapshotID int64
		if err := db.QueryRow(`
			INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json, fetched_at)
			VALUES (?, ?, 'example', ?, '2000-01-01 00:00:05') RETURNING id
		`, workID, remoteProviderID, remote[workID]).Scan(&snapshotID); err != nil {
			t.Fatal(err)
		}
		// An earlier projection version projected only the remote snapshot.
		if _, err := db.Exec(`
			INSERT INTO work_snapshot_projection (work_id, kind, snapshot_id, version, input_hash)
			VALUES (?, 'voice_credit', ?, ?, 'earlier')
		`, workID, snapshotID, voiceCreditProjectionVersion-1); err != nil {
			t.Fatal(err)
		}
	}
	// Persisting the remote work credited its voice actor with the remote id.
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := syncVoiceCreditSnapshot(ctx, tx, voiceCreditSnapshotRow{
		WorkID: 1, ProviderID: sql.NullInt64{Int64: remoteProviderID, Valid: true}, Raw: remote[1],
	}); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	if err := (&Server{db: db}).projectChangedVoiceCredits(ctx); err != nil {
		t.Fatal(err)
	}

	type identity struct{ Person, Provider, ID string }
	rows, err := db.Query(`
		SELECT person.display_name, provider.code, external.external_id
		FROM person_external_id AS external
		INNER JOIN person ON person.id = external.person_id
		INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
		WHERE external.id_type = 'voice_actor_id'
		ORDER BY person.display_name, provider.code
	`)
	if err != nil {
		t.Fatal(err)
	}
	identities := []identity{}
	for rows.Next() {
		var row identity
		if err := rows.Scan(&row.Person, &row.Provider, &row.ID); err != nil {
			t.Fatal(err)
		}
		identities = append(identities, row)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	wantIdentities := []identity{
		{"Example Voice A", "dlsite", "100"},
		{"Example Voice A", "test_remote_metadata", "va-1"},
		{"Example Voice B", "dlsite", "101"},
	}
	if !reflect.DeepEqual(identities, wantIdentities) {
		t.Fatalf("voice actor ids = %v, want %v", identities, wantIdentities)
	}

	type credit struct {
		WorkID           int64
		Person, Provider string
	}
	rows, err = db.Query(`
		SELECT credit.work_id, person.display_name, provider.code
		FROM work_credit AS credit
		INNER JOIN person ON person.id = credit.person_id
		INNER JOIN metadata_provider AS provider ON provider.id = credit.provider_id
		WHERE credit.role = 'voice_actor'
		ORDER BY credit.work_id, person.display_name
	`)
	if err != nil {
		t.Fatal(err)
	}
	credits := []credit{}
	for rows.Next() {
		var row credit
		if err := rows.Scan(&row.WorkID, &row.Person, &row.Provider); err != nil {
			t.Fatal(err)
		}
		credits = append(credits, row)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	wantCredits := []credit{{1, "Example Voice A", "dlsite"}, {2, "Example Voice B", "dlsite"}}
	var people int
	if err := db.QueryRow(`SELECT COUNT(*) FROM person`).Scan(&people); err != nil {
		t.Fatal(err)
	}
	if people != 2 || !reflect.DeepEqual(credits, wantCredits) {
		t.Fatalf("people = %d, voice credits = %v; want 2 and %v", people, credits, wantCredits)
	}
}

// A library that credited voice actors by name stored one DLsite creator as
// two people when an original and its translation spell the name differently.
// Projecting the snapshots, which carry the creator id, leaves one person
// named by the original edition with the translated spelling as an alias,
// credited once on each work, whichever edition is projected first, and a
// later projection of the translation does not rename them.
func TestVoiceCreditProjectionMergesOneCreatorAcrossEditionSpellings(t *testing.T) {
	for _, order := range []struct {
		name                      string
		originalID, translationID int64
	}{
		{"original first", 1, 2},
		{"translation first", 2, 1},
	} {
		t.Run(order.name, func(t *testing.T) {
			db := openMigratedTestDB(t)
			ctx := context.Background()
			for _, statement := range []string{
				fmt.Sprintf(`INSERT INTO work (id, primary_code, title) VALUES (%d, 'RJ00000000', 'Original Work'), (%d, 'RJ00000001', 'Translated Work')`, order.originalID, order.translationID),
				fmt.Sprintf(`INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, %d, 'RJ00000000')`, order.originalID),
				fmt.Sprintf(`INSERT INTO work_edition (work_id, logical_work_id, primary_code, is_canonical) VALUES (%d, 1, 'RJ00000000', 1), (%d, 1, 'RJ00000001', 0)`, order.originalID, order.translationID),
				// The name-only people and credits an earlier version stored.
				`INSERT INTO person (id, display_name, sort_name) VALUES (7, 'Example Voice', 'example voice'), (8, 'Example Voice Romanized', 'example voice romanized')`,
				`INSERT INTO person_alias (person_id, alias, source) VALUES (7, 'Example Voice', 'primary_name'), (8, 'Example Voice Romanized', 'primary_name')`,
				fmt.Sprintf(`INSERT INTO work_credit (work_id, person_id, role, provider_id, source)
					SELECT %d, 7, 'voice_actor', id, 'metadata_snapshot' FROM metadata_provider WHERE code = 'dlsite'
					UNION ALL SELECT %d, 8, 'voice_actor', id, 'metadata_snapshot' FROM metadata_provider WHERE code = 'dlsite'`, order.originalID, order.translationID),
			} {
				if _, err := db.Exec(statement); err != nil {
					t.Fatal(err)
				}
			}
			insertProjectionSnapshot(t, db, order.originalID, "2000-01-01 00:00:00", `{"workno":"RJ00000000","creaters":{"voice_by":[{"id":"200","name":"Example Voice","classification":"voice_by"}]}}`)
			insertProjectionSnapshot(t, db, order.translationID, "2000-01-01 00:00:00", `{"workno":"RJ00000001","creaters":{"voice_by":[{"id":"200","name":"Example Voice Romanized","classification":"voice_by"}]}}`)
			server := &Server{db: db}

			assertOnePerson := func(step string) {
				t.Helper()
				var people int
				var name string
				if err := db.QueryRow(`SELECT COUNT(*), MAX(display_name) FROM person`).Scan(&people, &name); err != nil {
					t.Fatal(err)
				}
				if people != 1 || name != "Example Voice" {
					t.Fatalf("%s: people = %d named %q, want one person named by the original edition", step, people, name)
				}
				var aliased bool
				if err := db.QueryRow(`SELECT EXISTS (SELECT 1 FROM person_alias WHERE alias = 'Example Voice Romanized')`).Scan(&aliased); err != nil {
					t.Fatal(err)
				}
				credits := map[int64]int{}
				rows, err := db.Query(`SELECT work_id, COUNT(*) FROM work_credit WHERE role = 'voice_actor' GROUP BY work_id`)
				if err != nil {
					t.Fatal(err)
				}
				for rows.Next() {
					var workID int64
					var count int
					if err := rows.Scan(&workID, &count); err != nil {
						t.Fatal(err)
					}
					credits[workID] = count
				}
				if err := rows.Close(); err != nil {
					t.Fatal(err)
				}
				if want := map[int64]int{order.originalID: 1, order.translationID: 1}; !aliased || !reflect.DeepEqual(credits, want) {
					t.Fatalf("%s: translated spelling aliased = %v, credits per work = %v, want true and %v", step, aliased, credits, want)
				}
			}

			if err := server.projectChangedVoiceCredits(ctx); err != nil {
				t.Fatal(err)
			}
			assertOnePerson("first projection")

			// Forget the translation's projection, as removing one of its credits does.
			if _, err := db.Exec(`DELETE FROM work_snapshot_projection WHERE work_id = ?`, order.translationID); err != nil {
				t.Fatal(err)
			}
			if err := server.projectChangedVoiceCredits(ctx); err != nil {
				t.Fatal(err)
			}
			assertOnePerson("translation projected again")
		})
	}
}
