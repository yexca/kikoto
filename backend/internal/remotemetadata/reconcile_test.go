package remotemetadata_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/remotemetadata"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/migrations"
)

func openRemoteDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "remote.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if err := storage.MigrateFS(db, migrations.Files, "test"); err != nil {
		t.Fatal(err)
	}
	return db
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) int64 {
	t.Helper()
	result, err := db.Exec(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	return id
}

// addRemoteSource registers a remote source and its provider; it returns the
// file source id and the provider id.
func addRemoteSource(t *testing.T, db *sql.DB, letter string, priority int, config string) (int64, int64) {
	t.Helper()
	code := "example_remote_" + strings.ToLower(letter)
	sourceID := mustExec(t, db, `INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
		VALUES (?, ?, 'kikoeru_compatible', ?, 1, ?)`, code, "Example Remote "+letter, priority, config)
	providerID := mustExec(t, db, "INSERT INTO metadata_provider (code, display_name) VALUES (?, ?)", remotemetadata.ProviderCode(code), "Example Remote "+letter)
	return sourceID, providerID
}

func addRemoteSnapshot(t *testing.T, db *sql.DB, workID, providerID int64, code string, work map[string]any) {
	t.Helper()
	work["source_id"] = code
	raw, err := json.Marshal(work)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json, variant_key) VALUES (?, ?, ?, ?, 'remote')`,
		workID, providerID, code, string(raw))
}

func setFallback(t *testing.T, db *sql.DB, enabled bool, ids ...int64) {
	t.Helper()
	raw, _ := json.Marshal(remotemetadata.Settings{Enabled: enabled, SourceIDs: ids})
	mustExec(t, db, `INSERT INTO app_setting (key, value_json) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, remotemetadata.SettingKey, string(raw))
}

func reconcile(t *testing.T, db *sql.DB, workID int64) remotemetadata.Result {
	t.Helper()
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := remotemetadata.ReconcileWorkTx(context.Background(), tx, workID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return result
}

func fieldSources(t *testing.T, db *sql.DB, workID int64) map[string]int64 {
	t.Helper()
	rows, err := db.Query("SELECT field_name, provider_id FROM work_metadata_field_source WHERE work_id = ?", workID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	result := map[string]int64{}
	for rows.Next() {
		var field string
		var provider int64
		if err := rows.Scan(&field, &provider); err != nil {
			t.Fatal(err)
		}
		result[field] = provider
	}
	return result
}

// Two remote sources describe the same work. The configured order, not the
// order the snapshots were written, decides every field and its provenance.
func TestReconcileFollowsConfiguredSourceOrderNotWriteOrder(t *testing.T) {
	db := openRemoteDB(t)
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	workID := mustExec(t, db, "INSERT INTO work (primary_code, title) VALUES (?, ?)", code, code)
	sourceA, providerA := addRemoteSource(t, db, "A", 10, "{}")
	sourceB, providerB := addRemoteSource(t, db, "B", 20, "{}")
	addRemoteSnapshot(t, db, workID, providerB, code, map[string]any{"title": "Example Work B", "release": "2026-02-02", "age_category_string": "general"})
	addRemoteSnapshot(t, db, workID, providerA, code, map[string]any{"title": "Example Work A"})

	// Without a configured order, source priority decides; A lacks a release
	// date, so that field alone comes from B.
	reconcile(t, db, workID)
	var title, release string
	if err := db.QueryRow("SELECT title, release_date FROM work WHERE id = ?", workID).Scan(&title, &release); err != nil {
		t.Fatal(err)
	}
	sources := fieldSources(t, db, workID)
	if title != "Example Work A" || release != "2026-02-02" || sources["title"] != providerA || sources["release_date"] != providerB || sources["age_rating"] != providerB {
		t.Fatalf("priority order: %q %q %v", title, release, sources)
	}

	// Selected sources come first in their configured order, enabled or not.
	setFallback(t, db, false, sourceB, sourceA)
	reconcile(t, db, workID)
	if err := db.QueryRow("SELECT title FROM work WHERE id = ?", workID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if sources := fieldSources(t, db, workID); title != "Example Work B" || sources["title"] != providerB {
		t.Fatalf("configured order: %q %v", title, sources)
	}
}

// DLsite metadata outranks every remote source: its values stay, remote data
// fills only an empty field, and no remote provenance is shown.
func TestReconcileNeverOverridesDLsiteMetadata(t *testing.T) {
	db := openRemoteDB(t)
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	workID := mustExec(t, db, "INSERT INTO work (primary_code, title, release_date) VALUES (?, 'Example Work', '2025-01-01')", code)
	mustExec(t, db, `INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		SELECT ?, id, ?, '{}' FROM metadata_provider WHERE code = 'dlsite'`, workID, code)
	_, provider := addRemoteSource(t, db, "A", 10, "{}")
	addRemoteSnapshot(t, db, workID, provider, code, map[string]any{"title": "Example Remote Title", "release": "2026-03-03", "age_category_string": "adult"})
	mustExec(t, db, "INSERT INTO work_metadata_field_source (work_id, field_name, provider_id) VALUES (?, 'title', ?)", workID, provider)

	result := reconcile(t, db, workID)
	var title, release, age string
	if err := db.QueryRow("SELECT title, release_date, age_rating FROM work WHERE id = ?", workID).Scan(&title, &release, &age); err != nil {
		t.Fatal(err)
	}
	if !result.HigherPriority || title != "Example Work" || release != "2025-01-01" || age != "adult" || len(fieldSources(t, db, workID)) != 0 {
		t.Fatalf("DLsite precedence: %+v %q %q %q %v", result, title, release, age, fieldSources(t, db, workID))
	}
}

// Only an active fallback source may create a circle; a passive source can
// only link an existing circle by name or confirmed alias.
func TestReconcileCreatesCirclesOnlyForActiveFallbackSources(t *testing.T) {
	db := openRemoteDB(t)
	sourceA, providerA := addRemoteSource(t, db, "A", 10, "{}")
	passiveCode := testfixture.WorkCode(testfixture.PrefixRJ, 2)
	passiveID := mustExec(t, db, "INSERT INTO work (primary_code, title) VALUES (?, ?)", passiveCode, passiveCode)
	addRemoteSnapshot(t, db, passiveID, providerA, passiveCode, map[string]any{"title": "Example Work 2", "circle": map[string]any{"id": 1, "name": "Example Circle 1"}})
	reconcile(t, db, passiveID)
	var circles int
	if err := db.QueryRow("SELECT COUNT(*) FROM party").Scan(&circles); err != nil || circles != 0 {
		t.Fatalf("passive source created a circle: %d %v", circles, err)
	}

	aliasParty := mustExec(t, db, "INSERT INTO party (display_name) VALUES ('Example Circle 2')")
	mustExec(t, db, "INSERT INTO party_alias (party_id, alias) VALUES (?, 'Example Circle Alias')", aliasParty)
	aliasCode := testfixture.WorkCode(testfixture.PrefixRJ, 3)
	aliasID := mustExec(t, db, "INSERT INTO work (primary_code, title) VALUES (?, ?)", aliasCode, aliasCode)
	addRemoteSnapshot(t, db, aliasID, providerA, aliasCode, map[string]any{"circle": map[string]any{"name": "example circle alias"}})
	reconcile(t, db, aliasID)
	var linked int64
	if err := db.QueryRow("SELECT party_id FROM work_party WHERE work_id = ? AND source = 'remote_source'", aliasID).Scan(&linked); err != nil || linked != aliasParty {
		t.Fatalf("alias match: %d %v", linked, err)
	}

	setFallback(t, db, true, sourceA)
	reconcile(t, db, passiveID)
	var name string
	if err := db.QueryRow(`SELECT party.display_name FROM work_party JOIN party ON party.id = work_party.party_id
		WHERE work_party.work_id = ? AND work_party.source = 'remote_source'`, passiveID).Scan(&name); err != nil || name != "Example Circle 1" {
		t.Fatalf("active source circle: %q %v", name, err)
	}
	if sources := fieldSources(t, db, passiveID); sources["circle"] != providerA {
		t.Fatalf("circle provenance: %v", sources)
	}
}

func TestDecodeBoundsUntrustedRemoteWorks(t *testing.T) {
	code := testfixture.WorkCode(testfixture.PrefixRJ, 4)
	tags := make([]map[string]any, 257)
	for index := range tags {
		tags[index] = map[string]any{"name": fmt.Sprintf("Example Tag %d", index)}
	}
	for name, raw := range map[string]any{
		"not an object":   []string{code},
		"missing code":    map[string]any{"title": "Example Work"},
		"too many tags":   map[string]any{"source_id": code, "tags": tags},
		"long tag name":   map[string]any{"source_id": code, "tags": []any{map[string]any{"name": strings.Repeat("x", 513)}}},
		"long title":      map[string]any{"source_id": code, "title": strings.Repeat("x", 2049)},
		"invalid circle":  map[string]any{"source_id": code, "circle": "Example Circle"},
		"long localized":  map[string]any{"source_id": code, "tags": []any{map[string]any{"name": "Example", "i18n": map[string]any{"en-us": map[string]any{"name": strings.Repeat("x", 513)}}}}},
		"invalid release": map[string]any{"source_id": code, "release": 20260101},
	} {
		encoded, _ := json.Marshal(raw)
		if _, err := remotemetadata.Decode(encoded); !errors.Is(err, remotemetadata.ErrInvalidWork) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := remotemetadata.Decode([]byte(`{"source_id":"` + code + `","title":"` + strings.Repeat("x", remotemetadata.MaxSnapshotBytes) + `"}`)); !errors.Is(err, remotemetadata.ErrInvalidWork) {
		t.Fatalf("oversized snapshot: %v", err)
	}
	work, err := remotemetadata.Decode([]byte(`{"source_id":"` + code + `","title":" Example Work ","release":"2026-04-05T00:00:00Z","duration":90.5,
		"tags":[{"name":"","i18n":{"EN_US":{"name":"Example English"},"zh-cn":{"name":"Example Chinese"},"xx":{"name":"Ignored"}}}]}`))
	if err != nil || work.Title != "Example Work" || work.Release != "2026-04-05" || work.Duration != 90 || len(work.Tags) != 1 ||
		work.Tags[0].Name != "Example English" || work.Tags[0].Names["zh-cn"] != "Example Chinese" || len(work.Tags[0].Names) != 2 {
		t.Fatalf("decoded work: %+v %v", work, err)
	}
}

func TestMetadataCapabilityIsDeclaredBySourceTypeAndConfig(t *testing.T) {
	for _, tc := range []struct {
		sourceType, config string
		want               bool
	}{
		{"kikoeru_compatible", "{}", true},
		{"kikoeru_compatible_number178", `{"requestLanguage":"ja-JP"}`, true},
		{"kikoeru_compatible", `{"capabilities":["metadata"]}`, true},
		{"kikoeru_compatible", `{"capabilities":[]}`, false},
		{"local_folder", `{"capabilities":["metadata"]}`, false},
		{"kikoeru_compatible", `not-json`, false},
	} {
		if got := remotemetadata.SupportsMetadata(tc.sourceType, tc.config); got != tc.want {
			t.Errorf("SupportsMetadata(%q, %q) = %v", tc.sourceType, tc.config, got)
		}
	}
}
