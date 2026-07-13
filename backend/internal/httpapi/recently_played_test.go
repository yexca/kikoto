package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestRecentlyPlayedWorksUsesLatestProgressPerWork(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	user, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('recent-user', 'Recent User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := user.LastInsertId()

	insertWork := func(code string) (int64, int64) {
		result, insertErr := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, ?)", code, code)
		if insertErr != nil {
			t.Fatal(insertErr)
		}
		workID, _ := result.LastInsertId()
		media, insertErr := db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'audio', 'Track', ?)", workID, code+"-track")
		if insertErr != nil {
			t.Fatal(insertErr)
		}
		mediaID, _ := media.LastInsertId()
		return workID, mediaID
	}
	olderWorkID, olderMediaID := insertWork("RJ09999301")
	newerWorkID, newerMediaID := insertWork("RJ09999302")
	for _, item := range []struct {
		mediaID int64
		played  string
		pos     float64
	}{{olderMediaID, "2026-07-13 10:00:00", 12}, {newerMediaID, "2026-07-14 10:00:00", 34}} {
		if _, err := db.Exec("INSERT INTO user_media_progress (user_id, media_item_id, position_seconds, duration_seconds, last_played_at) VALUES (?, ?, ?, 100, ?)", userID, item.mediaID, item.pos, item.played); err != nil {
			t.Fatal(err)
		}
	}

	works, err := server.recentlyPlayedWorks(context.Background(), userID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 2 || works[0].ID != newerWorkID || works[1].ID != olderWorkID {
		t.Fatalf("recent works = %#v", works)
	}
	if works[0].Progress.PositionSeconds != 34 {
		t.Fatalf("newest progress = %#v", works[0].Progress)
	}
}
