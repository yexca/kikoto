package httpapi

import (
	"context"
	"database/sql"
	"testing"
)

func insertProjectionSnapshot(t *testing.T, db *sql.DB, workID int64, fetchedAt string, raw string) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json, fetched_at)
		SELECT ?, id, 'RJ00000000', ?, ? FROM metadata_provider WHERE code = 'dlsite'
	`, workID, raw, fetchedAt); err != nil {
		t.Fatal(err)
	}
}

func recommendationInputRevision(t *testing.T, db *sql.DB) int {
	t.Helper()
	var revision int
	if err := db.QueryRow(`SELECT revision FROM recommendation_input_revision WHERE id = 1`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}

// Regression: startup and every metadata sync projected the whole library,
// rewriting each credit and advancing the recommendation revision per row.
func TestSnapshotProjectionOnlyWritesChangedProjectionInputs(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`); err != nil {
		t.Fatal(err)
	}
	insertProjectionSnapshot(t, db, 1, "2000-01-01 00:00:00", `{"workno":"RJ00000000","maker_id":"RG00000000","maker_name":"Example Circle","creaters":{"voice_by":[{"name":"Example Voice 1"}]},"dl_count":1}`)
	server := &Server{db: db}
	if err := server.projectChangedSnapshots(ctx); err != nil {
		t.Fatal(err)
	}
	var credits, circles int
	if err := db.QueryRow(`SELECT
		(SELECT COUNT(*) FROM work_credit WHERE work_id = 1 AND role = 'voice_actor'),
		(SELECT COUNT(*) FROM work_party WHERE work_id = 1 AND role = 'circle')`).Scan(&credits, &circles); err != nil {
		t.Fatal(err)
	}
	if credits != 1 || circles != 1 {
		t.Fatalf("first projection = %d credits, %d circles; want 1 and 1", credits, circles)
	}

	const earlier = "2000-02-02 00:00:00"
	if _, err := db.Exec(`UPDATE work_credit SET updated_at = ?`, earlier); err != nil {
		t.Fatal(err)
	}
	revision := recommendationInputRevision(t, db)
	// A newer snapshot that changes only a sales count keeps the credit and
	// circle rows as they are.
	insertProjectionSnapshot(t, db, 1, "2000-03-03 00:00:00", `{"workno":"RJ00000000","maker_id":"RG00000000","maker_name":"Example Circle","creaters":{"voice_by":[{"name":"Example Voice 1"}]},"dl_count":2}`)
	for range 2 {
		if err := server.projectChangedSnapshots(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var creditUpdatedAt string
	if err := db.QueryRow(`SELECT updated_at FROM work_credit WHERE work_id = 1`).Scan(&creditUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if got := recommendationInputRevision(t, db); got != revision || creditUpdatedAt != earlier {
		t.Fatalf("unchanged projection input: revision %d -> %d, credit updated_at %q; want no writes", revision, got, creditUpdatedAt)
	}

	// Removing a projected credit, as clearing a manual override can, lets
	// the next pass restore what the snapshot still declares.
	if _, err := db.Exec(`DELETE FROM work_credit WHERE work_id = 1`); err != nil {
		t.Fatal(err)
	}
	if err := server.projectChangedSnapshots(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_credit WHERE work_id = 1 AND role = 'voice_actor'`).Scan(&credits); err != nil {
		t.Fatal(err)
	}
	if credits != 1 {
		t.Fatalf("credits after removal and projection = %d, want the snapshot credit restored", credits)
	}
}

// Regression: every circle refresh appended a party snapshot that nothing read
// or removed.
func TestMakerProfileRefreshRetainsBoundedCircleSnapshots(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO party (id, party_type, display_name, sort_name) VALUES (1, 'circle', 'Example Circle', 'example circle')`); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{"pages_fetched":1}`, `{"pages_fetched":1}`, `{"pages_fetched":2}`, `{"pages_fetched":3}`} {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := updateMakerPartySnapshot(ctx, tx, 1, providerID, "Example Circle", "RG00000000", raw); err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	var retained string
	if err := db.QueryRow(`SELECT group_concat(snapshot_json, ' ') FROM (SELECT snapshot_json FROM party_metadata_snapshot WHERE party_id = 1 ORDER BY id)`).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if retained != `{"pages_fetched":2} {"pages_fetched":3}` {
		t.Fatalf("retained circle snapshots = %s, want the two latest distinct snapshots", retained)
	}
}
