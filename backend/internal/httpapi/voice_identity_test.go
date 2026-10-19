package httpapi

import (
	"context"
	"fmt"
	"reflect"
	"testing"
)

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
