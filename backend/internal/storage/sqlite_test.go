package storage

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOpenEnablesForeignKeysOnEveryConnection(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		CREATE TABLE parent (
			id INTEGER PRIMARY KEY
		);
		CREATE TABLE child (
			id INTEGER PRIMARY KEY,
			parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
		);
	`); err != nil {
		t.Fatalf("create tables: %v", err)
	}

	ctx := context.Background()
	conns := make([]*sql.Conn, 4)
	for i := range conns {
		conn, err := db.Conn(ctx)
		if err != nil {
			t.Fatalf("Conn(%d) error = %v", i, err)
		}
		conns[i] = conn
		defer conn.Close()
	}

	for i, conn := range conns {
		var enabled int
		if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&enabled); err != nil {
			t.Fatalf("PRAGMA foreign_keys on connection %d: %v", i, err)
		}
		if enabled != 1 {
			t.Fatalf("PRAGMA foreign_keys on connection %d = %d, want 1", i, enabled)
		}
		if _, err := conn.ExecContext(ctx, "INSERT INTO child (parent_id) VALUES (?)", 404); err == nil {
			t.Fatalf("connection %d allowed invalid foreign key insert", i)
		}
	}
}

func TestOpenSerializesImmediateWriteTransactions(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "transactions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE values_for_test (id INTEGER PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	first, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Exec("INSERT INTO values_for_test (value) VALUES ('first')"); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		second, err := db.BeginTx(context.Background(), nil)
		if err == nil {
			_, err = second.Exec("INSERT INTO values_for_test (value) VALUES ('second')")
			if err == nil {
				err = second.Commit()
			} else {
				_ = second.Rollback()
			}
		}
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("second transaction finished before the first committed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := first.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("second transaction did not resume after commit: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second transaction remained blocked")
	}
}

func TestOpenValidatesConnectionsBeforeReturningThemToThePool(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "validated-connections.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var validatorFound, connectionValid bool
	if err := conn.Raw(func(raw any) error {
		validator, ok := raw.(driver.Validator)
		validatorFound = ok
		if ok {
			connectionValid = validator.IsValid()
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !validatorFound {
		t.Fatal("SQLite driver does not validate interrupted connections before pooling")
	}
	if !connectionValid {
		t.Fatal("new SQLite connection is unexpectedly invalid")
	}
}

func TestCanceledStatementDoesNotLeaveWriterLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "canceled-writer.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE values_for_test (id INTEGER PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}

	contender, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer contender.Close()
	contender.SetMaxOpenConns(1)
	contender.SetMaxIdleConns(1)
	if _, err := contender.Exec("PRAGMA busy_timeout = 250"); err != nil {
		t.Fatal(err)
	}

	queryCtx, cancel := context.WithCancel(context.Background())
	tx, err := db.BeginTx(queryCtx, nil)
	if err != nil {
		t.Fatal(err)
	}
	queryResult := make(chan error, 1)
	go func() {
		var sum int64
		queryResult <- tx.QueryRowContext(queryCtx, `
			WITH RECURSIVE counter(value) AS (
				VALUES(0)
				UNION ALL
				SELECT value + 1 FROM counter WHERE value < 1000000000
			)
			SELECT SUM(value) FROM counter
		`).Scan(&sum)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-queryResult:
		if err == nil {
			t.Fatal("long-running statement completed before cancellation")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled statement did not return")
	}
	for deadline := time.Now().Add(time.Second); ; {
		if _, err := tx.Exec("SELECT 1"); err == sql.ErrTxDone {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("transaction was not rolled back after context cancellation")
		}
		time.Sleep(time.Millisecond)
	}

	writeCtx, writeCancel := context.WithTimeout(context.Background(), time.Second)
	defer writeCancel()
	if _, err := contender.ExecContext(writeCtx, "INSERT INTO values_for_test (value) VALUES ('after cancellation')"); err != nil {
		t.Fatalf("writer lock remained after canceled statement: %v", err)
	}
}

func TestOpenMemoryDatabase(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open(:memory:) error = %v", err)
	}
	defer db.Close()

	var enabled int
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&enabled); err != nil {
		t.Fatalf("PRAGMA foreign_keys: %v", err)
	}
	if enabled != 1 {
		t.Fatalf("PRAGMA foreign_keys = %d, want 1", enabled)
	}
}

func TestNormalizedTagMigrationBackfillsEscapedUnicodeSnapshots(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	migrationDir := filepath.Join("..", "..", "migrations")
	initialSQL, err := os.ReadFile(filepath.Join(migrationDir, "001_initial.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(initialSQL)); err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000003', 'Migration test')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	snapshot := `{"product":{"genres":[{"name":"\u30ed\u30ea"},{"name":"\u8033\u304b\u304d"}]},"_kikoto":{"language":"ja_JP"}}`
	if _, err := db.Exec("INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, 'RJ00000003', ?)", workID, providerID, snapshot); err != nil {
		t.Fatal(err)
	}

	tagSQL, err := os.ReadFile(filepath.Join(migrationDir, "002_v0_1_1.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(tagSQL)); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		WHERE work_tag.work_id = ? AND tag.display_name IN ('ロリ', '耳かき')
	`, workID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("normalized Unicode tags = %d, want 2", count)
	}
}

func TestWorkCodeAliasMigrationBackfillsDeclaredLanguageEditions(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	preAliasDir := t.TempDir()
	entries, err := os.ReadDir(migrationDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == "008_work_code_alias.sql" {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(migrationDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(preAliasDir, entry.Name()), contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	db, err := Open(filepath.Join(t.TempDir(), "code-alias.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db, preAliasDir); err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000000', 'Canonical')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	logicalResult, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ00000000')", workID)
	if err != nil {
		t.Fatal(err)
	}
	logicalWorkID, _ := logicalResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, is_canonical)
		VALUES (?, ?, ?, 'RJ00000000', 1)
	`, workID, logicalWorkID, providerID); err != nil {
		t.Fatal(err)
	}
	snapshot := `{"product":{"language_editions":[{"workno":"RJ00000000","lang":"JPN","label":"Japanese"},{"workno":"RJ00000001","lang":"ENG","label":"English"}]}}`
	if _, err := db.Exec("INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, 'RJ00000000', ?)", workID, providerID, snapshot); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db, migrationDir); err != nil {
		t.Fatal(err)
	}

	var sourceWorkID sql.NullInt64
	var language, label, kind string
	if err := db.QueryRow(`
		SELECT source_work_id, metadata_language, edition_label, relationship_kind
		FROM work_code_alias
		WHERE provider_id = ? AND primary_code = 'RJ00000001'
	`, providerID).Scan(&sourceWorkID, &language, &label, &kind); err != nil {
		t.Fatal(err)
	}
	if sourceWorkID.Valid || language != "ENG" || label != "English" || kind != "provider_declared" {
		t.Fatalf("declared alias = source %v, language %q, label %q, kind %q", sourceWorkID, language, label, kind)
	}
	var persistedSourceID sql.NullInt64
	if err := db.QueryRow("SELECT source_work_id FROM work_code_alias WHERE provider_id = ? AND primary_code = 'RJ00000000'", providerID).Scan(&persistedSourceID); err != nil {
		t.Fatal(err)
	}
	if !persistedSourceID.Valid || persistedSourceID.Int64 != workID {
		t.Fatalf("persisted alias source = %v, want %d", persistedSourceID, workID)
	}
}

func TestMigrateUpgradesV010DatabaseThroughCurrentMigrations(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	initialSQL, err := os.ReadFile(filepath.Join(migrationDir, "001_initial.sql"))
	if err != nil {
		t.Fatal(err)
	}
	v010Dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(v010Dir, "001_initial.sql"), initialSQL, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := Open(filepath.Join(t.TempDir(), "v0.1.0.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db, v010Dir); err != nil {
		t.Fatalf("create v0.1.0 database: %v", err)
	}
	if _, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000002', 'Preserved')"); err != nil {
		t.Fatal(err)
	}
	var workID, providerID int64
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code = 'RJ00000002'").Scan(&workID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	snapshot := `{"product":{"age_category_string":"general","official_price":0,"price":0},"dynamic":{"rate_average_2dp":4.5,"dl_count":321,"official_price":0,"price":0,"discount_rate":0,"is_discount":false}}`
	if _, err := db.Exec("INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, 'RJ00000002', ?)", workID, providerID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO file_source (code, display_name, source_type) VALUES ('legacy-number178', 'Legacy number178', 'kikoeru_compilable_number178')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'file', 'Preview', 'local:RJ00000002:bonus/preview.mp4')", workID); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("upgrade v0.1.0 database: %v", err)
	}
	rows, err := db.Query("SELECT filename FROM schema_migration ORDER BY filename")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var migrations []string
	for rows.Next() {
		var filename string
		if err := rows.Scan(&filename); err != nil {
			t.Fatal(err)
		}
		migrations = append(migrations, filename)
	}
	if len(migrations) != 25 || migrations[0] != "001_initial.sql" || migrations[1] != "002_v0_1_1.sql" || migrations[2] != "003_user_media_lyrics_preference.sql" || migrations[3] != "004_person_external_identity.sql" || migrations[4] != "005_workflow_event_cursor.sql" || migrations[5] != "006_file_source_work_url_template.sql" || migrations[6] != "007_fix_legacy_number178_source_type.sql" || migrations[7] != "008_work_code_alias.sql" || migrations[8] != "009_work_commercial_metadata.sql" || migrations[9] != "010_work_metadata_provider_state.sql" || migrations[10] != "011_recommendation_telemetry.sql" || migrations[11] != "012_media_video.sql" || migrations[12] != "013_media_video_backfill.sql" || migrations[13] != "014_workflow_job_priority.sql" || migrations[14] != "015_workflow_notification.sql" || migrations[15] != "016_workflow_job_resource.sql" || migrations[16] != "017_availability_watch.sql" || migrations[17] != "018_merge_startup_library_refresh.sql" || migrations[18] != "019_local_scan_filesystem_trigger.sql" || migrations[19] != "020_filesystem_event_watcher.sql" || migrations[20] != "021_reconcile_work_party_provenance.sql" || migrations[21] != "022_user_work_playback_cursor.sql" || migrations[22] != "023_fetch_transfer_operations.sql" || migrations[23] != "024_remote_source_outbound_policy.sql" || migrations[24] != "025_decouple_local_scan_metadata.sql" {
		t.Fatalf("migrations = %v", migrations)
	}
	var localScanDefinitionCount, startupRefreshDefinitionCount, localScanStartupCount, localScanFilesystemCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_definition WHERE code = 'local_library_scan'").Scan(&localScanDefinitionCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_definition WHERE code = 'startup_library_refresh'").Scan(&startupRefreshDefinitionCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan' AND trigger.trigger_type = 'startup'
	`).Scan(&localScanStartupCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan' AND trigger.trigger_type = 'filesystem_event'
	`).Scan(&localScanFilesystemCount); err != nil {
		t.Fatal(err)
	}
	if localScanDefinitionCount != 1 || startupRefreshDefinitionCount != 0 || localScanStartupCount != 1 || localScanFilesystemCount != 1 {
		t.Fatalf("merged local scan definitions/triggers = %d/%d/%d/%d", localScanDefinitionCount, startupRefreshDefinitionCount, localScanStartupCount, localScanFilesystemCount)
	}
	var localScanNodeCount, localScanMetadataNodeCount, disabledFollowUpConfigCount int
	if err := db.QueryRow(`
		SELECT json_array_length(definition_json, '$.nodes'),
			(SELECT COUNT(*) FROM json_each(definition_json, '$.nodes') WHERE json_extract(value, '$.id') = 'metadata')
		FROM workflow_definition
		WHERE code = 'local_library_scan'
	`).Scan(&localScanNodeCount, &localScanMetadataNodeCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan'
			AND json_extract(trigger.config_json, '$.followUpRun') = 0
	`).Scan(&disabledFollowUpConfigCount); err != nil {
		t.Fatal(err)
	}
	if localScanNodeCount != 4 || localScanMetadataNodeCount != 0 || disabledFollowUpConfigCount != 2 {
		t.Fatalf("decoupled local scan = nodes %d metadata nodes %d disabled follow-up configs %d", localScanNodeCount, localScanMetadataNodeCount, disabledFollowUpConfigCount)
	}
	var filesystemStateTableCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'filesystem_trigger_state'").Scan(&filesystemStateTableCount); err != nil {
		t.Fatal(err)
	}
	if filesystemStateTableCount != 1 {
		t.Fatalf("filesystem trigger state table count = %d", filesystemStateTableCount)
	}
	var filesystemStateCount, watchedDirectoryCount int
	var lastEventAt sql.NullString
	if err := db.QueryRow("SELECT COUNT(*), watched_directory_count, last_event_at FROM filesystem_trigger_state").Scan(&filesystemStateCount, &watchedDirectoryCount, &lastEventAt); err != nil {
		t.Fatal(err)
	}
	if filesystemStateCount != 1 || watchedDirectoryCount != 0 || lastEventAt.Valid {
		t.Fatalf("filesystem event state = %d/%d/%v", filesystemStateCount, watchedDirectoryCount, lastEventAt)
	}
	var rating float64
	var sales, regularPrice, currentPrice int64
	var currency string
	var permanentlyFree bool
	if err := db.QueryRow(`
		SELECT rating_average, sales_count, regular_price, current_price, price_currency, is_permanently_free
		FROM work WHERE id = ?
	`, workID).Scan(&rating, &sales, &regularPrice, &currentPrice, &currency, &permanentlyFree); err != nil {
		t.Fatal(err)
	}
	if rating != 4.5 || sales != 321 || regularPrice != 0 || currentPrice != 0 || currency != "JPY" || !permanentlyFree {
		t.Fatalf("commercial backfill = %v/%d/%d/%d/%q/%t", rating, sales, regularPrice, currentPrice, currency, permanentlyFree)
	}
	var videoKind string
	var videoHasAudio sql.NullBool
	if err := db.QueryRow("SELECT kind, has_audio FROM media_item WHERE fingerprint LIKE '%.mp4'").Scan(&videoKind, &videoHasAudio); err != nil {
		t.Fatal(err)
	}
	if videoKind != "video" || videoHasAudio.Valid {
		t.Fatalf("video backfill = kind %q, has_audio %v", videoKind, videoHasAudio)
	}
	var lyricsPreferenceTable int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'user_media_lyrics_preference'").Scan(&lyricsPreferenceTable); err != nil {
		t.Fatal(err)
	}
	if lyricsPreferenceTable != 1 {
		t.Fatalf("user_media_lyrics_preference table count = %d", lyricsPreferenceTable)
	}
	var legacySourceType string
	if err := db.QueryRow("SELECT source_type FROM file_source WHERE code = 'legacy-number178'").Scan(&legacySourceType); err != nil {
		t.Fatal(err)
	}
	if legacySourceType != "kikoeru_compatible_number178" {
		t.Fatalf("legacy source type = %q", legacySourceType)
	}
	for table, column := range map[string]string{
		"work_edition":               "translation_kind",
		"workflow_job":               "resource_key",
		"remote_fetch_manifest_item": "resolution",
		"availability_watch_target":  "availability_epoch",
	} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?", table, column).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("column %s.%s count = %d", table, column, count)
		}
	}
	var workflowPriorityColumn int
	if err := db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('workflow_job') WHERE name = 'priority'").Scan(&workflowPriorityColumn); err != nil {
		t.Fatal(err)
	}
	if workflowPriorityColumn != 1 {
		t.Fatalf("column workflow_job.priority count = %d", workflowPriorityColumn)
	}
	var preserved int
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = 'RJ00000002'").Scan(&preserved); err != nil {
		t.Fatal(err)
	}
	if preserved != 1 {
		t.Fatalf("preserved work count = %d", preserved)
	}
	var workURLTemplate string
	if err := db.QueryRow(`SELECT dflt_value FROM pragma_table_info('file_source_endpoint') WHERE name = 'work_url_template'`).Scan(&workURLTemplate); err != nil {
		t.Fatal(err)
	}
	if workURLTemplate != "'/work/{code}'" {
		t.Fatalf("work_url_template default = %q", workURLTemplate)
	}
	var restrictOutboundHostsDefault, allowedHostPatternsDefault string
	if err := db.QueryRow(`SELECT dflt_value FROM pragma_table_info('file_source_endpoint') WHERE name = 'restrict_outbound_hosts'`).Scan(&restrictOutboundHostsDefault); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT dflt_value FROM pragma_table_info('file_source_endpoint') WHERE name = 'allowed_host_patterns_json'`).Scan(&allowedHostPatternsDefault); err != nil {
		t.Fatal(err)
	}
	if restrictOutboundHostsDefault != "0" || allowedHostPatternsDefault != "'[]'" {
		t.Fatalf("outbound policy defaults = %q / %q", restrictOutboundHostsDefault, allowedHostPatternsDefault)
	}
}

func TestMergeStartupLibraryRefreshMigrationKeepsExistingLocalStartupTrigger(t *testing.T) {
	db := openWorkflowMergeMigrationDB(t)
	defer db.Close()

	if _, err := db.Exec(`
		INSERT INTO workflow_trigger (
			workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json
		)
		SELECT id, 'startup', 'Existing local startup', 1, '{"type":"startup"}', '{}'
		FROM workflow_definition
		WHERE code = 'local_library_scan'
	`); err != nil {
		t.Fatal(err)
	}

	applyWorkflowMergeMigration(t, db)

	var startupCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan' AND trigger.trigger_type = 'startup'
	`).Scan(&startupCount); err != nil {
		t.Fatal(err)
	}
	if startupCount != 1 {
		t.Fatalf("local scan startup trigger count = %d, want 1", startupCount)
	}
}

func TestMergeStartupLibraryRefreshMigrationDoesNotRestoreDeletedStartupTrigger(t *testing.T) {
	db := openWorkflowMergeMigrationDB(t)
	defer db.Close()

	if _, err := db.Exec(`
		DELETE FROM workflow_trigger
		WHERE workflow_definition_id = (
			SELECT id FROM workflow_definition WHERE code = 'startup_library_refresh'
		)
		AND trigger_type = 'startup'
	`); err != nil {
		t.Fatal(err)
	}

	applyWorkflowMergeMigration(t, db)

	var startupCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan' AND trigger.trigger_type = 'startup'
	`).Scan(&startupCount); err != nil {
		t.Fatal(err)
	}
	if startupCount != 0 {
		t.Fatalf("local scan startup trigger count = %d, want 0", startupCount)
	}
}

func openWorkflowMergeMigrationDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	initialSQL, err := os.ReadFile(filepath.Join("..", "..", "migrations", "001_initial.sql"))
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	if _, err := db.Exec(string(initialSQL)); err != nil {
		db.Close()
		t.Fatal(err)
	}
	return db
}

func applyWorkflowMergeMigration(t *testing.T, db *sql.DB) {
	t.Helper()
	migrationSQL, err := os.ReadFile(filepath.Join("..", "..", "migrations", "018_merge_startup_library_refresh.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(migrationSQL)); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateAddsQueryIndexes(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "indexed.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	for table, index := range map[string]string{
		"metadata_snapshot":         "idx_metadata_snapshot_work_provider_latest",
		"work":                      "idx_work_primary_code_upper",
		"work_edition":              "idx_work_edition_primary_code_upper",
		"work_code_alias":           "idx_work_code_alias_code_upper",
		"party_series_work":         "idx_party_series_work_code_upper",
		"workflow_event":            "idx_workflow_event_run_id",
		"workflow_job":              "idx_workflow_job_resource_status",
		"availability_watch_target": "idx_availability_watch_target_due",
	} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM pragma_index_list(?) WHERE name = ?", table, index).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("index %s on %s count = %d, want 1", index, table, count)
		}
	}
}
