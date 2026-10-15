package storage

import (
	"path/filepath"
	"testing"
)

// Migration 078 turns enabled follow triggers into subscriptions whose
// pulled catalogs are their baseline, renames the follow presets, and moves
// the Availability Watch interval to the subscription schedule.
func TestMigrationConvertsFollowTriggersIntoSubscriptions(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 77)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'subscriber', 'admin')`,
		`INSERT INTO party (id, display_name) VALUES (10, 'Example Circle 1'), (11, 'Example Circle 2')`,
		`INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
			VALUES (10, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'maker_id', 'RG00001', 1),
				(11, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'maker_id', 'RG00002', 1)`,
		`INSERT INTO party_catalog_item (party_id, provider_id, primary_code)
			VALUES (10, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000001'),
				(11, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000002')`,
		`INSERT INTO party_catalog_refresh_state (party_id, provider_code, last_success_at) VALUES (10, 'dlsite', '2026-10-01T00:00:00Z')`,
		`INSERT INTO party_series (id, party_id, provider_id, title_id, name)
			VALUES (30, 10, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'SRI0000000001', 'Example Series 1')`,
		`INSERT INTO person (id, display_name) VALUES (7, 'Example Voice')`,
		`INSERT INTO workflow_definition (id, code, display_name, scope, editable)
			VALUES (101, 'circle_follow', 'Follow a circle', 'system', 0),
				(102, 'series_follow', 'Follow a series', 'system', 0),
				(103, 'voice_follow', 'Follow a voice actor', 'system', 0)`,
		`INSERT INTO workflow_trigger (id, workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
			VALUES (201, 101, 'schedule', 'Circles', 1, '{"intervalMinutes":1440}', '{"userId":1,"inputs":{"circleId":"RG00001, RG00002"}}'),
				(202, 102, 'schedule', 'Series', 1, '{"intervalMinutes":1440}', '{"userId":1,"inputs":{"seriesId":"SRI0000000001"}}'),
				(203, 103, 'startup', 'Voice', 1, '{"type":"startup"}', '{"userId":1,"inputs":{"personId":7,"sourceIds":[1]}}'),
				(204, 103, 'schedule', 'Paused voice', 0, '{"intervalMinutes":1440}', '{"userId":1,"inputs":{"personId":8,"sourceIds":[1]}}'),
				(205, (SELECT id FROM workflow_definition WHERE code = 'availability_watch'), 'schedule', 'Watch', 1, '{"intervalMinutes":360}', '{"userId":1}')`,
		`INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type) VALUES ('circle_follow', 'Follow a circle', 'succeeded', 'manual')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}

	rows, err := db.Query(`
		SELECT subject_kind, COALESCE(party_id, 0), series_title_id, COALESCE(person_id, 0), activated_at IS NOT NULL
		FROM creator_subscription WHERE user_id = 1 ORDER BY subject_kind, party_id, person_id
	`)
	if err != nil {
		t.Fatal(err)
	}
	type subscription struct {
		kind      string
		partyID   int64
		seriesID  string
		personID  int64
		activated bool
	}
	got := []subscription{}
	for rows.Next() {
		var item subscription
		if err := rows.Scan(&item.kind, &item.partyID, &item.seriesID, &item.personID, &item.activated); err != nil {
			t.Fatal(err)
		}
		got = append(got, item)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	// The series belongs to a subscribed circle, so the circle covers it; the
	// paused voice trigger is not converted.
	want := []subscription{
		{kind: "circle", partyID: 10, activated: true},
		{kind: "circle", partyID: 11, activated: false},
		{kind: "voice", personID: 7, activated: false},
	}
	if len(got) != len(want) {
		t.Fatalf("subscriptions = %+v, want %+v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("subscriptions = %+v, want %+v", got, want)
		}
	}
	var seen int
	if err := db.QueryRow(`SELECT COUNT(*) FROM party_release_seen WHERE party_id = 10 AND primary_code = 'RJ00000001'`).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if seen != 1 {
		t.Fatal("an active subscription's catalog is its baseline")
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM party_release_seen WHERE party_id = 11`).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if seen != 0 {
		t.Fatal("a pending subscription takes its baseline from its first pull")
	}

	var presetTriggers, legacyCodes int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code IN ('circle_catalog_sync', 'series_catalog_sync', 'voice_catalog_sync', 'availability_watch')
	`).Scan(&presetTriggers); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT (SELECT COUNT(*) FROM workflow_definition WHERE code LIKE '%_follow')
			+ (SELECT COUNT(*) FROM workflow_run WHERE workflow_code LIKE '%_follow')
	`).Scan(&legacyCodes); err != nil {
		t.Fatal(err)
	}
	if presetTriggers != 0 || legacyCodes != 0 {
		t.Fatalf("preset and watch triggers = %d, follow codes = %d", presetTriggers, legacyCodes)
	}
	var interval int
	var watch, enabled bool
	var nextRunAt *string
	if err := db.QueryRow(`
		SELECT CAST(json_extract(trigger.schedule_json, '$.intervalMinutes') AS INTEGER),
			json_extract(trigger.config_json, '$.availabilityWatch'), trigger.enabled, trigger.next_run_at
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'creator_subscription_refresh'
	`).Scan(&interval, &watch, &enabled, &nextRunAt); err != nil {
		t.Fatal(err)
	}
	if interval != 360 || !watch || !enabled || nextRunAt != nil {
		t.Fatalf("subscription schedule = interval %d watch %v enabled %v next %v", interval, watch, enabled, nextRunAt)
	}
}
