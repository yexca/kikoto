package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestRecentlyPlayedWorksKeepsCompletedWorkCursor(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	user, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('recent-user', 'Recent User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := user.LastInsertId()

	insertWork := func(code string, kind string) (int64, int64) {
		result, insertErr := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, ?)", code, code)
		if insertErr != nil {
			t.Fatal(insertErr)
		}
		workID, _ := result.LastInsertId()
		media, insertErr := db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint, has_audio) VALUES (?, ?, 'Track', ?, 1)", workID, kind, code+"-track")
		if insertErr != nil {
			t.Fatal(insertErr)
		}
		mediaID, _ := media.LastInsertId()
		return workID, mediaID
	}
	olderWorkID, olderMediaID := insertWork("RJ09999301", "audio")
	newerWorkID, newerMediaID := insertWork("RJ09999302", "video")
	for _, item := range []struct {
		workID    int64
		mediaID   int64
		played    string
		pos       float64
		completed bool
	}{{olderWorkID, olderMediaID, "2026-07-13 10:00:00", 12, false}, {newerWorkID, newerMediaID, "2026-07-14 10:00:00", 100, true}} {
		if _, err := db.Exec(`
			INSERT INTO user_work_playback_cursor (
				user_id, work_id, media_item_id, position_seconds, duration_seconds, completed, last_played_at
			) VALUES (?, ?, ?, ?, 100, ?, ?)
		`, userID, item.workID, item.mediaID, item.pos, item.completed, item.played); err != nil {
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
	if works[0].Progress.PositionSeconds != 100 || !works[0].Progress.Completed {
		t.Fatalf("newest progress = %#v", works[0].Progress)
	}
}
