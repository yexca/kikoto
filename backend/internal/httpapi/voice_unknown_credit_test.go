package httpapi

import (
	"context"
	"database/sql"
	"testing"
)

// A snapshot that names no voice actor credits the unknown voice actor; once
// a later snapshot names a real one, the unknown credit goes.
func TestVoiceCreditsDropTheUnknownVoiceActorOnceARealOneIsCredited(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec("INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000012', 'Example Work')"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	project := func(raw string) {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback() }()
		if err := syncVoiceCreditSnapshot(ctx, tx, voiceCreditSnapshotRow{WorkID: 1, ProviderID: sql.NullInt64{}, Raw: raw}); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	credited := func() []string {
		t.Helper()
		rows, err := db.Query(`SELECT person.display_name FROM work_credit INNER JOIN person ON person.id = work_credit.person_id
			WHERE work_credit.work_id = 1 AND work_credit.role = 'voice_actor' ORDER BY person.display_name`)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		names := []string{}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				t.Fatal(err)
			}
			names = append(names, name)
		}
		return names
	}

	project(`{"workno":"RJ00000012"}`)
	if names := credited(); len(names) != 1 || names[0] != unknownVoiceActorName {
		t.Fatalf("credits without a named voice actor = %v", names)
	}
	project(`{"workno":"RJ00000012","creaters":{"voice_by":[{"name":"Example Voice"}]}}`)
	if names := credited(); len(names) != 1 || names[0] != "Example Voice" {
		t.Fatalf("credits once a voice actor is named = %v, want only Example Voice", names)
	}
}

// A later snapshot that names no voice actor leaves a work that credits a real
// one as it is, without adding and removing the unknown voice actor; and a
// changed voice credit projection version re-projects every work, so existing
// data loses its unknown credits too.
func TestVoiceCreditsKeepARealCreditAgainstAnEmptySnapshot(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000025', 'Example Work');
		INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice', 'example voice');
		INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'metadata_snapshot');
	`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := syncVoiceCreditSnapshot(ctx, tx, voiceCreditSnapshotRow{WorkID: 1, Raw: `{"workno":"RJ00000025"}`}); err != nil {
		t.Fatal(err)
	}
	var unknown int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM person WHERE LOWER(display_name) = 'unknown'`).Scan(&unknown); err != nil || unknown != 0 {
		t.Fatalf("unknown voice actors created = %d, %v", unknown, err)
	}
	if voiceCreditProjectionVersion < 4 {
		t.Fatalf("voice credit projection version = %d; a change to the projection needs a new version", voiceCreditProjectionVersion)
	}
}
