package personal

import (
	"context"
	"database/sql"
	"testing"
)

// splitFamilyStore holds a family whose canonical work is work 1 and whose
// edition, work 2, still carries one account's personal state beside the
// state the canonical work already has.
func splitFamilyStore(t *testing.T) Store {
	t.Helper()
	s := testStore(t)
	for _, statement := range []string{
		`INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000000')`,
		`INSERT INTO work_edition (work_id, logical_work_id, primary_code, is_canonical) VALUES (1, 1, 'RJ00000000', 1), (2, 1, 'RJ00000001', 0)`,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Track'), (2, 2, 'audio', 'Track')`,
		`INSERT INTO user_work_state (user_id, work_id, listening_status, rating, note, created_at, updated_at)
			VALUES (1, 1, 'none', NULL, 'Kept note', '2026-01-01 00:00:00', '2026-01-02 00:00:00'),
				(1, 2, 'listening', 4, 'Edition note', '2025-12-01 00:00:00', '2026-02-01 00:00:00'),
				(2, 2, 'finished', 5, '', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
		`INSERT INTO favorite_list (id, user_id, name, kind) VALUES (1, 1, 'Example List', 'user'), (2, 1, 'Other List', 'user')`,
		`INSERT INTO favorite_list_item (list_id, work_id, created_at) VALUES (1, 1, '2026-03-01 00:00:00'), (1, 2, '2026-01-01 00:00:00'), (2, 2, '2026-01-05 00:00:00')`,
		`INSERT INTO user_work_playback_cursor (user_id, work_id, media_item_id, position_seconds, last_played_at)
			VALUES (1, 1, 1, 10, '2026-01-01 00:00:00'), (1, 2, 2, 42, '2026-02-01 00:00:00')`,
		`INSERT INTO user_listening_session (user_id, session_id, work_id, listened_seconds) VALUES (1, 'synthetic-session-1', 2, 60)`,
		`INSERT INTO user_listening_day (user_id, work_id, day, listened_seconds, listen_count) VALUES (1, 1, '2026-01-01', 30, 1), (1, 2, '2026-01-01', 60, 1), (1, 2, '2026-01-02', 90, 1)`,
		`INSERT INTO user_listening_import (user_id, work_id, listened_seconds, listen_count, last_played_at) VALUES (1, 2, 120, 2, '2025-12-01 00:00:00')`,
		`INSERT INTO favorite_list (id, user_id, name, kind) VALUES (3, 1, 'Smart List', 'smart')`,
		`INSERT INTO favorite_list_smart_seen (list_id, work_id) VALUES (3, 2)`,
		`INSERT INTO user_tag (id, user_id, name) VALUES (1, 1, 'Example Tag'), (2, 1, 'Other Tag')`,
		`INSERT INTO user_work_tag (user_id, work_id, user_tag_id, created_at)
			VALUES (1, 1, 1, '2026-03-01 00:00:00'), (1, 2, 1, '2026-01-01 00:00:00'), (1, 2, 2, '2026-02-01 00:00:00')`,
	} {
		execFixture(t, s.DB, statement)
	}
	return s
}

// Startup repair moves the state an edition holds onto its family's
// canonical work and merges it with what is there.
func TestConsolidateSplitFamiliesMovesEditionStateToTheCanonicalWork(t *testing.T) {
	s := splitFamilyStore(t)
	ctx := context.Background()
	if err := ConsolidateSplitFamilies(ctx, s.DB); err != nil {
		t.Fatal(err)
	}

	for _, table := range []string{"user_work_state", "user_work_tag", "favorite_list_item", "user_work_playback_cursor", "user_listening_session", "user_listening_day", "user_listening_import"} {
		var left int
		if err := s.DB.QueryRow("SELECT COUNT(*) FROM " + table + " WHERE work_id = 2").Scan(&left); err != nil {
			t.Fatal(err)
		}
		if left != 0 {
			t.Fatalf("%s still holds %d rows on the edition", table, left)
		}
	}
	var status, note string
	var rating sql.NullInt64
	var favorite bool
	if err := s.DB.QueryRow(`SELECT listening_status, rating, note, favorite FROM user_work_state WHERE user_id = 1 AND work_id = 1`).Scan(&status, &rating, &note, &favorite); err != nil {
		t.Fatal(err)
	}
	if status != "listening" || rating.Int64 != 4 || note != "Kept note\n\nEdition note" || !favorite {
		t.Fatalf("merged state = %q %v %q favorite=%v", status, rating, note, favorite)
	}
	if err := s.DB.QueryRow(`SELECT listening_status, rating FROM user_work_state WHERE user_id = 2 AND work_id = 1`).Scan(&status, &rating); err != nil || status != "finished" || rating.Int64 != 5 {
		t.Fatalf("moved state of the other account = %q %v, %v", status, rating, err)
	}
	var memberships int
	var joined string
	if err := s.DB.QueryRow(`SELECT COUNT(*), MIN(created_at) FROM favorite_list_item WHERE list_id = 1 AND work_id = 1`).Scan(&memberships, &joined); err != nil {
		t.Fatal(err)
	}
	if memberships != 1 || joined != "2026-01-01 00:00:00" {
		t.Fatalf("list 1 memberships = %d joined %s, want one dated by the earlier", memberships, joined)
	}
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM favorite_list_item WHERE list_id = 2 AND work_id = 1`).Scan(&memberships); err != nil || memberships != 1 {
		t.Fatalf("list 2 memberships = %d, %v", memberships, err)
	}
	var position float64
	if err := s.DB.QueryRow(`SELECT position_seconds FROM user_work_playback_cursor WHERE user_id = 1 AND work_id = 1`).Scan(&position); err != nil || position != 42 {
		t.Fatalf("cursor position = %v, %v; want the later cursor", position, err)
	}
	var tags int
	var tagged string
	if err := s.DB.QueryRow(`SELECT COUNT(*), (SELECT created_at FROM user_work_tag WHERE user_id = 1 AND work_id = 1 AND user_tag_id = 1) FROM user_work_tag WHERE user_id = 1 AND work_id = 1`).Scan(&tags, &tagged); err != nil {
		t.Fatal(err)
	}
	if tags != 2 || tagged != "2026-01-01 00:00:00" {
		t.Fatalf("canonical tags = %d, shared tag dated %s; want both tags, dated by the earlier", tags, tagged)
	}
	var sessionWork int64
	if err := s.DB.QueryRow(`SELECT work_id FROM user_listening_session WHERE session_id = 'synthetic-session-1'`).Scan(&sessionWork); err != nil || sessionWork != 1 {
		t.Fatalf("session work = %d, %v", sessionWork, err)
	}

	var dayTotal float64
	var importTotal float64
	if err := s.DB.QueryRow(`SELECT (SELECT SUM(listened_seconds) FROM user_listening_day WHERE work_id = 1), (SELECT listened_seconds FROM user_listening_import WHERE work_id = 1)`).Scan(&dayTotal, &importTotal); err != nil || dayTotal != 180 || importTotal != 120 {
		t.Fatalf("canonical listening = %v days, %v imported, %v", dayTotal, importTotal, err)
	}
	// Smart-list seen marks belong to the works a rule matched, editions
	// included, so they stay where they are and never make the family split.
	var seen int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM favorite_list_smart_seen WHERE work_id = 2`).Scan(&seen); err != nil || seen != 1 {
		t.Fatalf("edition seen marks = %d, %v", seen, err)
	}
	canonical, members, err := familyStateToMove(ctx, s.DB, 1)
	if err != nil || canonical != 1 || len(members) != 0 {
		t.Fatalf("state left to move = %v, %v; want none", members, err)
	}

	// Nothing is left to repair.
	if err := ConsolidateSplitFamilies(ctx, s.DB); err != nil {
		t.Fatal(err)
	}
}

// A mark or rating cleared after the row was created stays cleared when an
// older row of the family is merged into it.
func TestMergeWorkStateKeepsAClearedMark(t *testing.T) {
	cleared := workStateRow{status: "none", createdAt: "2026-01-01 00:00:00", updatedAt: "2026-03-01 00:00:00"}
	older := workStateRow{status: "listening", rating: sql.NullInt64{Int64: 5, Valid: true}, createdAt: "2025-01-01 00:00:00", updatedAt: "2026-02-01 00:00:00"}
	if merged := mergeWorkState(cleared, older); merged.status != "none" || merged.rating.Valid {
		t.Fatalf("merged = %+v, want the cleared mark and rating", merged)
	}
	fresh := workStateRow{status: "none", createdAt: "2026-03-01 00:00:00", updatedAt: "2026-03-01 00:00:00"}
	if merged := mergeWorkState(fresh, older); merged.status != "listening" || merged.rating.Int64 != 5 {
		t.Fatalf("merged = %+v, want the older mark beside a row never changed", merged)
	}
}

// Writes that name an edition resolve to the canonical work.
func TestCanonicalWorkIDResolvesAnEditionToItsFamily(t *testing.T) {
	s := splitFamilyStore(t)
	ctx := context.Background()
	for workID, want := range map[int64]int64{1: 1, 2: 1, 3: 3} {
		got, err := CanonicalWorkID(ctx, s.DB, workID)
		if err != nil || got != want {
			t.Fatalf("CanonicalWorkID(%d) = %d, %v; want %d", workID, got, err, want)
		}
	}
}
