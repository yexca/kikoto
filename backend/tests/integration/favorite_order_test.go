package integration_test

import (
	"context"
	"database/sql"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestFavoriteActivityOrderIgnoresPlaybackAndOtherUsers(t *testing.T) {
	db := favoriteOrderDatabase(t)
	store := library.NewStore(db)
	assertOrder := func(want []int64) {
		t.Helper()
		works, err := store.ListMatchingSorted(context.Background(), "1 = 1", nil, library.MatchingListOptions{
			UserID: 1, Sort: "activity", Direction: "desc",
		})
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]int64, len(works))
		for index, work := range works {
			ids[index] = work.ID
		}
		if !reflect.DeepEqual(ids, want) {
			t.Fatalf("favorite activity order = %v, want %v", ids, want)
		}
	}
	// Work 2 has the latest list activity; work 3 has the latest quick mark.
	assertOrder([]int64{2, 3, 1})
	if _, err := db.Exec(`
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'Example Track', 'example-track');
		INSERT INTO user_work_playback_cursor (user_id, work_id, media_item_id, last_played_at)
		VALUES (1, 1, 1, '2026-03-01 00:00:00');
		INSERT INTO favorite_list_item (list_id, work_id, created_at) VALUES (14, 1, '2026-04-01 00:00:00');
	`); err != nil {
		t.Fatal(err)
	}
	assertOrder([]int64{2, 3, 1})
}

func TestFavoriteAddedOrderUsesSelectedListOrMarkedMembership(t *testing.T) {
	db := favoriteOrderDatabase(t)
	for _, scenario := range []struct {
		name      string
		listID    int64
		direction string
		want      []int64
	}{
		{name: "selected list ascending", listID: 12, direction: "asc", want: []int64{2, 3, 1}},
		{name: "selected list descending", listID: 12, direction: "desc", want: []int64{1, 3, 2}},
		{name: "marked ascending", listID: 11, direction: "asc", want: []int64{1, 2, 3}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			works, err := library.NewStore(db).ListMatchingSorted(context.Background(), "1 = 1", nil, library.MatchingListOptions{
				UserID: 1, ListID: scenario.listID, Sort: "added", Direction: scenario.direction,
			})
			if err != nil {
				t.Fatal(err)
			}
			ids := make([]int64, len(works))
			for index, work := range works {
				ids[index] = work.ID
			}
			if !reflect.DeepEqual(ids, scenario.want) {
				t.Fatalf("added order = %v, want %v", ids, scenario.want)
			}
		})
	}
}

func favoriteOrderDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db := openMigratedTestDB(t, "favorite-order.db")
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES
		(1, 'synthetic-user', 'Example User', 'user'), (2, 'synthetic-user-2', 'Example User 2', 'user');
		INSERT INTO favorite_list (id, user_id, name, kind) VALUES
		(11, 1, '', 'marked'), (12, 1, 'Example List', 'user'),
		(13, 1, 'Example Other List', 'user'), (14, 2, 'Example Private List', 'user');
	`); err != nil {
		t.Fatal(err)
	}
	for id := 1; id <= 3; id++ {
		if _, err := db.Exec("INSERT INTO work (id, primary_code, title, created_at) VALUES (?, ?, 'Example Work', '2026-01-01 00:00:00')", id, testfixture.WorkCode(testfixture.PrefixRJ, id)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO user_work_state (user_id, work_id, listening_status, updated_at) VALUES
		(1, 1, 'finished', '2026-01-04 00:00:00'),
		(1, 2, 'want_to_listen', '2026-01-05 00:00:00'),
		(1, 3, 'relisten', '2026-01-06 00:00:00');
		INSERT INTO favorite_list_item (list_id, work_id, created_at) VALUES
		(12, 1, '2026-01-03 00:00:00'), (12, 2, '2026-01-01 00:00:00'),
		(12, 3, '2026-01-02 00:00:00'), (13, 2, '2026-02-01 00:00:00');
	`); err != nil {
		t.Fatal(err)
	}
	return db
}
