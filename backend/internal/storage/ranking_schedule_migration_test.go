package storage

import (
	"database/sql"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Migration 094 joins the lists of one period into one list whose variants
// keep the earlier lists' snapshots, entries, and seen state; gives every list
// its own schedule; turns popular collection triggers into lists; removes the
// shared ranking refresh schedule; and stops collections still queued or
// running.
func TestMigrationJoinsRankingListsAndConvertsPopularCollectionTriggers(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 93)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'ranking-viewer', 'user')`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled)
			VALUES (5, 'remote_a', 'Example Remote A', 'kikoeru_compatible', 1),
				(7, 'remote_b', 'Example Remote B', 'kikoeru_compatible_number178', 0)`,
		`INSERT INTO workflow_definition (id, code, display_name, scope, editable)
			VALUES (301, 'ranking_refresh', 'Refresh rankings', 'system', 0),
				(302, 'dlsite_popular_collection', 'Collect DLsite popular voice works', 'system', 0),
				(303, 'remote_popular_collection', 'Collect popular remote works', 'system', 0)`,
		`INSERT INTO ranking_list (id, provider, file_source_id, period, release_window, depth, enabled, position, last_pulled_at, last_status)
			VALUES (1, 'dlsite', NULL, 'day', '', 100, 1, 0, '2026-10-20 00:00:00', 'succeeded'),
				(2, 'remote_source', 5, '', '', 50, 1, 1, NULL, ''),
				(3, 'dlsite', NULL, 'day', '30d', 50, 0, 2, '2026-10-19 00:00:00', 'failed')`,
		`INSERT INTO ranking_snapshot (id, ranking_list_id, pulled_at, item_count, content_hash)
			VALUES (11, 1, '2026-10-18 00:00:00', 0, 'older'), (12, 1, '2026-10-19 00:00:00', 0, 'latest'),
				(13, 3, '2026-10-18 12:00:00', 1, 'new-releases')`,
		`INSERT INTO ranking_snapshot_item (snapshot_id, rank, primary_code) VALUES (13, 1, 'RJ00000005')`,
		`INSERT INTO ranking_entry (ranking_list_id, primary_code, first_seen_at, streak_started_at, last_seen_at, best_rank)
			VALUES (3, 'RJ00000005', '2026-10-18 12:00:00', '2026-10-18 12:00:00', '2026-10-18 12:00:00', 1)`,
		`INSERT INTO user_ranking_state (user_id, ranking_list_id, seen_snapshot_id) VALUES (1, 3, 13)`,
		`INSERT INTO workflow_trigger (id, workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json, next_run_at)
			VALUES (401, 301, 'schedule', 'Ranking refresh', 0, '{"intervalMinutes":720}', '{}', NULL),
				(402, 302, 'schedule', 'Weekly new', 1, '{"intervalMinutes":120}', '{"userId":1,"period":"week","releaseWindow":"30d","tagNameTemplate":"DL_{period}"}', '2026-10-21 00:00:00'),
				(405, 302, 'schedule', 'Weekly paused', 0, '{"intervalMinutes":60}', '{"userId":1,"period":"week"}', NULL),
				(403, 302, 'startup', 'Daily new', 1, '{"type":"startup"}', '{"userId":1,"period":"day","releaseWindow":"30d","skipTag":true}', NULL),
				(404, 302, 'schedule', 'Year 2020', 1, '{"intervalMinutes":1440}', '{"userId":1,"period":"year","year":2020}', NULL),
				(406, 303, 'schedule', 'Remote B', 0, '{"intervalMinutes":20}', '{"userId":1,"sourceId":7,"action":"track","limit":5}', NULL),
				(407, 303, 'startup', 'Removed source', 1, '{"type":"startup"}', '{"userId":1,"sourceId":99,"action":"track","limit":20}', NULL),
				(408, 303, 'schedule', 'Malformed', 1, 'not json', 'not json', NULL)`,
		`INSERT INTO workflow_run (id, workflow_definition_id, trigger_id, workflow_code, display_name, status, trigger_type)
			VALUES (501, 302, 402, 'dlsite_popular_collection', 'Collect DLsite popular voice works', 'running', 'schedule'),
				(502, 303, 406, 'remote_popular_collection', 'Collect popular remote works', 'succeeded', 'schedule')`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, status)
			VALUES (601, 501, 'tag', 'assign_user_tags', 'Add user tag', 'queued')`,
		`INSERT INTO workflow_job (workflow_run_id, worker_type, status, recoverable)
			VALUES (501, 'dlsite_popular_collection', 'running', 1)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("%v\n%s", err, statement)
		}
	}
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 94)); err != nil {
		t.Fatal(err)
	}

	type list struct {
		id                                    int64
		autoRefresh, enabled, interval, depth int
		year, follow                          int
		nextPullAt, requestedAt               sql.NullString
		variants                              string
	}
	lists := map[string]list{}
	rows, err := db.Query(`SELECT list.id, list.provider, COALESCE(list.file_source_id, 0), list.period, list.year, list.depth,
		list.enabled, list.auto_refresh, list.refresh_interval_minutes, list.follow_current_year, list.next_pull_at, list.pull_requested_at,
		(SELECT group_concat(variant.id || ':' || variant.release_window || '/' || variant.sort, ',') FROM (
			SELECT * FROM ranking_variant WHERE ranking_list_id = list.id ORDER BY release_window, sort
		) AS variant)
		FROM ranking_list AS list`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var provider, period string
		var sourceID int64
		var item list
		if err := rows.Scan(&item.id, &provider, &sourceID, &period, &item.year, &item.depth, &item.enabled,
			&item.autoRefresh, &item.interval, &item.follow, &item.nextPullAt, &item.requestedAt, &item.variants); err != nil {
			t.Fatal(err)
		}
		key := provider + ":" + period
		if provider == "remote_source" {
			key = provider + ":" + strconv.FormatInt(sourceID, 10)
		}
		lists[key] = item
	}
	_ = rows.Close()
	if len(lists) != 5 {
		t.Fatalf("lists = %+v, want the joined day list, the remote list, and three converted triggers", lists)
	}
	// The two day lists join the one with the smaller id, and the enabled
	// Startup trigger of their period joins them. The list is shown, keeps the
	// larger depth, and is automatic because the trigger was, at the trigger's
	// default interval rather than the paused shared schedule's; the earlier
	// lists become its variants by id, and the other orders are added.
	day := lists["dlsite:day"]
	if day.id != 1 || day.enabled != 1 || day.depth != 100 || day.autoRefresh != 1 || day.interval != 60 || !day.nextPullAt.Valid || !day.requestedAt.Valid {
		t.Fatalf("joined day list = %+v", day)
	}
	if !strings.HasPrefix(day.variants, "1:/,") || !strings.Contains(day.variants, ",3:30d/,") || strings.Count(day.variants, ",") != 3 {
		t.Fatalf("day variants = %s", day.variants)
	}
	if remote := lists["remote_source:5"]; remote.id != 2 || remote.interval != 720 || remote.depth != 50 || remote.variants != "2:/" {
		t.Fatalf("tracked remote list = %+v", remote)
	}
	// A trigger limited to new releases names the list of its period. Joined
	// with a paused trigger of the period, the list stays automatic at the
	// enabled trigger's interval.
	if week := lists["dlsite:week"]; week.autoRefresh != 1 || week.interval != 120 || !week.nextPullAt.Valid || strings.Count(week.variants, ",") != 3 {
		t.Fatalf("converted interval trigger = %+v", week)
	}
	if annual := lists["dlsite:year"]; annual.year != 2020 || annual.autoRefresh != 0 || annual.follow != 0 || !annual.requestedAt.Valid || strings.Count(annual.variants, ",") != 1 || strings.Contains(annual.variants, "30d") {
		t.Fatalf("converted past-year trigger = %+v", annual)
	}
	// A paused trigger stays paused, its interval within the remote range and
	// its limit raised to the smallest depth.
	if remote := lists["remote_source:7"]; remote.autoRefresh != 0 || remote.interval != 60 || remote.depth != 10 || strings.Contains(remote.variants, ",") {
		t.Fatalf("converted remote trigger = %+v", remote)
	}

	// Snapshots, entries, and seen state stay with the variant of their list.
	confirmed := map[int64]string{}
	variants := map[int64]int64{}
	snapshotRows, err := db.Query(`SELECT id, ranking_variant_id, confirmed_until FROM ranking_snapshot`)
	if err != nil {
		t.Fatal(err)
	}
	for snapshotRows.Next() {
		var id, variant int64
		var until string
		if err := snapshotRows.Scan(&id, &variant, &until); err != nil {
			t.Fatal(err)
		}
		confirmed[id], variants[id] = until, variant
	}
	_ = snapshotRows.Close()
	if variants[11] != 1 || variants[12] != 1 || variants[13] != 3 {
		t.Fatalf("snapshot variants = %+v", variants)
	}
	if confirmed[11] != "2026-10-18 00:00:00" || confirmed[12] != "2026-10-20 00:00:00" || confirmed[13] != "2026-10-19 00:00:00" {
		t.Fatalf("confirmed until = %+v", confirmed)
	}
	var entryVariant, seenVariant, seenSnapshot int64
	if err := db.QueryRow(`SELECT ranking_variant_id FROM ranking_entry WHERE primary_code = 'RJ00000005'`).Scan(&entryVariant); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT ranking_variant_id, seen_snapshot_id FROM user_ranking_state WHERE user_id = 1`).Scan(&seenVariant, &seenSnapshot); err != nil {
		t.Fatal(err)
	}
	if entryVariant != 3 || seenVariant != 3 || seenSnapshot != 13 {
		t.Fatalf("entry variant %d, seen variant %d snapshot %d", entryVariant, seenVariant, seenSnapshot)
	}

	var triggers int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_trigger WHERE id BETWEEN 401 AND 408`).Scan(&triggers); err != nil {
		t.Fatal(err)
	}
	var definitions string
	if err := db.QueryRow(`SELECT group_concat(code, ',') FROM (SELECT code FROM workflow_definition WHERE id BETWEEN 301 AND 303 ORDER BY id)`).Scan(&definitions); err != nil {
		t.Fatal(err)
	}
	if triggers != 0 || definitions != "dlsite_popular_collection,remote_popular_collection" {
		t.Fatalf("triggers = %d, definitions = %s", triggers, definitions)
	}

	var runStatus, nodeStatus, jobStatus, jobError string
	var triggerID sql.NullInt64
	if err := db.QueryRow(`SELECT run.status, run.trigger_id, node.status, job.status, job.error_message
		FROM workflow_run AS run
		INNER JOIN workflow_node_run AS node ON node.workflow_run_id = run.id
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE run.id = 501`).Scan(&runStatus, &triggerID, &nodeStatus, &jobStatus, &jobError); err != nil {
		t.Fatal(err)
	}
	if runStatus != "cancelled" || triggerID.Valid || nodeStatus != "cancelled" || jobStatus != "cancelled" || !strings.Contains(jobError, "Rankings") {
		t.Fatalf("active collection = run %s trigger %v node %s job %s %q", runStatus, triggerID, nodeStatus, jobStatus, jobError)
	}
	var finished string
	if err := db.QueryRow(`SELECT status FROM workflow_run WHERE id = 502`).Scan(&finished); err != nil || finished != "succeeded" {
		t.Fatalf("finished collection = %s %v", finished, err)
	}
}
