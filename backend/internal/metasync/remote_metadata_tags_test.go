package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func projectRemoteWork(t *testing.T, db *sql.DB, workID int64, priorities []string) {
	t.Helper()
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := ProjectWorkMetadataTagsTx(context.Background(), tx, workID, priorities); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func remoteWorkTags(t *testing.T, db *sql.DB, workID int64) (map[string]bool, bool) {
	t.Helper()
	tags, err := metadatatags.Read(context.Background(), db, workID)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tag := range tags {
		names[tag.DisplayName] = true
	}
	projected, err := metadatatags.Projected(context.Background(), db, workID)
	if err != nil {
		t.Fatal(err)
	}
	return names, projected
}

// Remote tags enter shared tags only while the opt-in fallback uses their
// source, follow later snapshot refreshes through the durable queue, and leave
// again when the fallback is turned off.
func TestRemoteSnapshotTagsFoldIntoSharedTagsOnlyWhileFallbackIsEnabled(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	// Shared tags are stored in the original language.
	priorities := metadatatags.StoredLanguages
	code := testfixture.WorkCode(testfixture.PrefixRJ, 10)
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, ?)", code, code)
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := result.LastInsertId()
	if _, err := db.Exec(`INSERT INTO dlsite_genre_name (genre_id, language, name) VALUES (1, 'ja-jp', 'Example Genre'), (1, 'en-us', 'Example Genre EN')`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := metadatatags.EnsureGenreTx(ctx, tx, 1); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	result, err = db.Exec(`INSERT INTO file_source (code, display_name, source_type) VALUES ('example_remote_a', 'Example Remote A', 'kikoeru_compatible')`)
	if err != nil {
		t.Fatal(err)
	}
	sourceID, _ := result.LastInsertId()
	result, err = db.Exec(`INSERT INTO metadata_provider (code, display_name) VALUES ('kikoeru_source_example_remote_a', 'Example Remote A')`)
	if err != nil {
		t.Fatal(err)
	}
	providerID, _ := result.LastInsertId()
	snapshot := func(tags ...map[string]any) string {
		raw, _ := json.Marshal(map[string]any{"source_id": code, "title": "Example Work 10", "tags": tags})
		return string(raw)
	}
	if _, err := db.Exec(`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, ?, ?)`, workID, providerID, code,
		snapshot(map[string]any{"name": "example genre"}, map[string]any{"name": "Example Remote Tag", "i18n": map[string]any{"ja-jp": map[string]any{"name": "Example Remote Tag"}, "en-us": map[string]any{"name": "Example Remote Tag EN"}}})); err != nil {
		t.Fatal(err)
	}

	projectRemoteWork(t, db, workID, priorities)
	if names, projected := remoteWorkTags(t, db, workID); len(names) != 0 || projected {
		t.Fatalf("disabled fallback folded remote tags: %v projected=%v", names, projected)
	}

	setting, _ := json.Marshal(remotemetadata.Settings{Enabled: true, SourceIDs: []int64{sourceID}})
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, ?)`, remotemetadata.SettingKey, string(setting)); err != nil {
		t.Fatal(err)
	}
	projectRemoteWork(t, db, workID, priorities)
	names, projected := remoteWorkTags(t, db, workID)
	if !projected || len(names) != 2 || !names["Example Genre"] || !names["Example Remote Tag"] {
		t.Fatalf("enabled fallback tags: %v projected=%v", names, projected)
	}
	var tagSource int64
	if err := db.QueryRow("SELECT provider_id FROM work_metadata_field_source WHERE work_id = ? AND field_name = 'tags'", workID).Scan(&tagSource); err != nil || tagSource != providerID {
		t.Fatalf("tag provenance: %d %v", tagSource, err)
	}
	if id, err := metadatatags.FindByName(ctx, db, "example remote tag en"); err != nil || id == 0 {
		t.Fatalf("provider names are not reusable concept names: %d %v", id, err)
	}

	// A refreshed snapshot reaches the durable queue through its trigger.
	if _, err := db.Exec("UPDATE metadata_snapshot SET snapshot_json = ? WHERE work_id = ? AND provider_id = ?", snapshot(map[string]any{"name": "Example Second Tag"}), workID, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := ProcessMetadataTagQueue(ctx, db, 64, priorities); err != nil {
		t.Fatal(err)
	}
	if names, _ := remoteWorkTags(t, db, workID); len(names) != 1 || !names["Example Second Tag"] {
		t.Fatalf("refreshed remote tags: %v", names)
	}

	if _, err := db.Exec(`UPDATE app_setting SET value_json = '{"enabled":false,"sourceIds":[]}' WHERE key = ?`, remotemetadata.SettingKey); err != nil {
		t.Fatal(err)
	}
	projectRemoteWork(t, db, workID, priorities)
	names, projected = remoteWorkTags(t, db, workID)
	var provenance int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_field_source WHERE work_id = ? AND field_name = 'tags'", workID).Scan(&provenance); err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 || projected || provenance != 0 {
		t.Fatalf("disabling the fallback kept remote tags: %v projected=%v provenance=%d", names, projected, provenance)
	}
}
