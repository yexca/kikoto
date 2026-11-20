package record

import (
	"context"
	"testing"
)

// Progress follows the client's capture order: a save that arrives after a
// later one never replaces it.
func TestRecordProgressKeepsTheLatestSaveInClientOrder(t *testing.T) {
	store, db, _ := scannedStore(t, map[string]string{"trip/clip.mp4": "video"})
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO user_account(id,username,role,enabled) VALUES (7,'viewer','user',1)`); err != nil {
		t.Fatal(err)
	}
	asset := assetID(t, db, "clip.mp4")
	for _, save := range []struct {
		position float64
		order    int64
		stored   bool
	}{
		{position: 120, order: 2000, stored: true},
		{position: 30, order: 1000, stored: false},
		{position: 150, order: 3000, stored: true},
	} {
		stored, err := store.SaveProgress(ctx, 7, asset, Progress{PositionSeconds: save.position, Order: save.order})
		if err != nil || stored != save.stored {
			t.Fatalf("save at %v order %d stored = %v, %v; want %v", save.position, save.order, stored, err, save.stored)
		}
	}
	if progress, err := store.Progress(ctx, 7, asset); err != nil || progress.PositionSeconds != 150 {
		t.Fatalf("progress = %+v, %v; want the save captured last", progress, err)
	}
}
