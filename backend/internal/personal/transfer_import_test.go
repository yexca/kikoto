package personal

import (
	"context"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestImportedProgressRejectsEarlierOfflineReportsAndAllowsLaterBackwardSeeks(t *testing.T) {
	for _, tc := range []struct {
		name     string
		existing bool
		offset   time.Duration
	}{{"new cursor", false, 0}, {"existing cursor", true, -10 * time.Second}, {"existing clock ahead", true, time.Second}} {
		t.Run(tc.name, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			execFixture(t, s.DB, `INSERT INTO media_item (id,work_id,kind,title,fingerprint) VALUES (1,1,'audio','Example Track','synthetic-track')`)
			now := time.Now()
			checkpoint := ProgressInput{ReportID: "synthetic-before-import", Order: now.Add(-5 * time.Second).UnixMilli(), MediaItemID: 1, PositionSeconds: 20}
			if tc.existing {
				existing := checkpoint
				existing.Order = now.Add(tc.offset).UnixMilli()
				existing.PositionSeconds = 120
				if _, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{existing}}); err != nil {
					t.Fatal(err)
				}
			}
			code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
			backup := Backup{Works: []BackupWork{{PrimaryCode: code, ListeningStatus: "paused", Progress: &BackupProgress{MediaWorkCode: code, MediaTitle: "Example Track", PositionSeconds: 90, LastPlayedAt: "2026-01-01 00:00:00"}}}}
			beforeImport := time.Now().UnixMilli()
			result, err := s.Import(ctx, 1, backup, true)
			if err != nil || result.ImportedWorks != 1 || result.SkippedProgress != 0 {
				t.Fatalf("import = %+v %v", result, err)
			}
			var barrier int64
			var lastPlayed string
			if err = s.DB.QueryRow(`SELECT report_order,last_played_at FROM user_work_playback_cursor WHERE user_id=1 AND work_id=1`).Scan(&barrier, &lastPlayed); err != nil || barrier < beforeImport || (tc.existing && barrier <= now.Add(tc.offset).UnixMilli()) || lastPlayed != backup.Works[0].Progress.LastPlayedAt {
				t.Fatalf("import barrier = %d / %s: %v", barrier, lastPlayed, err)
			}
			for _, order := range []int64{checkpoint.Order, barrier} {
				checkpoint.Order = order
				checkpoint.ReportID = "zz-synthetic-offline"
				replayed, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{checkpoint}})
				if err != nil || replayed.Progress[0].Status != "stale" {
					t.Fatalf("earlier/tied replay = %+v %v", replayed, err)
				}
			}
			var position float64
			if err = s.DB.QueryRow(`SELECT position_seconds FROM user_work_playback_cursor WHERE user_id=1 AND work_id=1`).Scan(&position); err != nil || position != 90 {
				t.Fatalf("imported position = %v %v", position, err)
			}
			for i, position := range []float64{25, 10} {
				checkpoint.Order = barrier + int64(i) + 1
				checkpoint.PositionSeconds = position
				later, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{checkpoint}})
				if err != nil || later.Progress[0].Cursor == nil || later.Progress[0].Cursor.PositionSeconds != position {
					t.Fatalf("later backward checkpoint = %+v %v", later, err)
				}
			}
		})
	}
}
