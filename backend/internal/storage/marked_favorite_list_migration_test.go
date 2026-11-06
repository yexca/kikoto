package storage

import (
	"path/filepath"
	"testing"
)

func TestMarkedFavoriteListMigrationPreservesExplicitLegacyFavorites(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 27)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(1, 'RJ00000001', 'Example Legacy Favorite'),
			(2, 'RJ00000002', 'Example Empty Default');
		INSERT INTO favorite_list (id, user_id, name, sort_order) VALUES (1, 1, 'Favorites', 0);
		INSERT INTO favorite_list_item (list_id, work_id) VALUES (1, 1);
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES
			(1, 1, 'none', 1),
			(1, 2, 'want_to_listen', 0);
	`); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("apply marked-list migration: %v", err)
	}
	var userFavoritesKind, markedKind string
	if err := db.QueryRow("SELECT kind FROM favorite_list WHERE id = 1").Scan(&userFavoritesKind); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT kind FROM favorite_list WHERE user_id = 1 AND kind = 'marked'").Scan(&markedKind); err != nil {
		t.Fatal(err)
	}
	if userFavoritesKind != "user" || markedKind != "marked" {
		t.Fatalf("list kinds = %q / %q, want user / marked", userFavoritesKind, markedKind)
	}
	var membershipCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM favorite_list_item WHERE list_id = 1 AND work_id = 1").Scan(&membershipCount); err != nil {
		t.Fatal(err)
	}
	if membershipCount != 1 {
		t.Fatalf("legacy membership count = %d, want 1", membershipCount)
	}
}

func TestMarkedFavoriteListMigrationConvertsEmptyLegacyDefault(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 27)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO favorite_list (id, user_id, name, sort_order) VALUES (1, 1, 'Favorites', 0);
	`); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("apply marked-list migration: %v", err)
	}
	var kind, name string
	var sortOrder int
	if err := db.QueryRow("SELECT kind, name, sort_order FROM favorite_list WHERE id = 1").Scan(&kind, &name, &sortOrder); err != nil {
		t.Fatal(err)
	}
	if kind != "marked" || name != "" || sortOrder != -1 {
		t.Fatalf("converted list = kind %q, name %q, sort order %d; want marked, empty, -1", kind, name, sortOrder)
	}
	var markedCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM favorite_list WHERE user_id = 1 AND kind = 'marked'").Scan(&markedCount); err != nil {
		t.Fatal(err)
	}
	if markedCount != 1 {
		t.Fatalf("marked list count = %d, want 1", markedCount)
	}
}

func TestMarkedFavoriteListMigrationMovesStateOnlyFavoritesOutOfConvertedDefault(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 27)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Example State Favorite');
		INSERT INTO favorite_list (id, user_id, name, sort_order) VALUES (1, 1, 'Favorites', 0);
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite)
		VALUES (1, 1, 'none', 1);
	`); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("apply marked-list migration: %v", err)
	}
	var markedKind, userKind string
	if err := db.QueryRow("SELECT kind FROM favorite_list WHERE id = 1").Scan(&markedKind); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT kind FROM favorite_list WHERE user_id = 1 AND name = 'Favorites'").Scan(&userKind); err != nil {
		t.Fatal(err)
	}
	if markedKind != "marked" || userKind != "user" {
		t.Fatalf("converted/default kinds = %q / %q, want marked / user", markedKind, userKind)
	}
	var membershipCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM favorite_list_item AS item
		INNER JOIN favorite_list AS list ON list.id = item.list_id
		WHERE list.user_id = 1 AND list.kind = 'user' AND item.work_id = 1
	`).Scan(&membershipCount); err != nil {
		t.Fatal(err)
	}
	if membershipCount != 1 {
		t.Fatalf("state-only favorite membership count = %d, want 1", membershipCount)
	}
}

func TestMarkedFavoriteListMigrationPreservesExistingUserStateTimestamps(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 27)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(1, 'RJ00000001', 'Example Listed Work'),
			(2, 'RJ00000002', 'Example Unlisted Work');
		INSERT INTO favorite_list (id, user_id, name, sort_order) VALUES (1, 1, 'Study', 0);
		INSERT INTO favorite_list_item (list_id, work_id) VALUES (1, 1);
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite, updated_at) VALUES
			(1, 1, 'none', 0, '2026-08-01 00:00:00'),
			(1, 2, 'finished', 0, '2026-08-02 00:00:00');
	`); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("apply marked-list migration: %v", err)
	}
	var listedUpdatedAt, unlistedUpdatedAt string
	var listedFavorite, unlistedFavorite int
	if err := db.QueryRow("SELECT updated_at, favorite FROM user_work_state WHERE user_id = 1 AND work_id = 1").Scan(&listedUpdatedAt, &listedFavorite); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT updated_at, favorite FROM user_work_state WHERE user_id = 1 AND work_id = 2").Scan(&unlistedUpdatedAt, &unlistedFavorite); err != nil {
		t.Fatal(err)
	}
	if listedUpdatedAt != "2026-08-01 00:00:00" || unlistedUpdatedAt != "2026-08-02 00:00:00" {
		t.Fatalf("state timestamps changed during migration: %q / %q", listedUpdatedAt, unlistedUpdatedAt)
	}
	if listedFavorite != 1 || unlistedFavorite != 0 {
		t.Fatalf("favorite summaries = %d / %d, want 1 / 0", listedFavorite, unlistedFavorite)
	}
}
