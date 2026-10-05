package httpapi

import (
	"context"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestSnapshotTagFallbackSurvivesGlobalBackfillMarkerAndEmptyProjectionIsAuthoritative(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	ctx := context.Background()
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	work := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Synthetic snapshot work')", code)
	insertProjectionSnapshot(t, db, work, "2026-01-01 00:00:00", `{"product":{"genres":[{"id":1,"name":"Synthetic fallback genre"}]}}`)
	metadataReviewExec(t, db, "INSERT INTO app_setting(key,value_json) VALUES ('metadata_tag_projection_version','1')")
	tags, projected, err := s.loadProjectedDLsiteTags(ctx, work)
	if err != nil || projected || tags != nil {
		t.Fatalf("unprojected snapshot fallback = %v, %v, %v", tags, projected, err)
	}
	batch, err := s.loadProjectedDLsiteTagsBatch(ctx, []int64{work}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := batch[work]; exists {
		t.Fatalf("global marker falsely cleared snapshot tags: %v", batch)
	}
	detail := workDetail{ID: work, PrimaryCode: code}
	if _, err := s.populateWorkDetailMetadata(ctx, &detail); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(detail.Tags, []string{"Synthetic fallback genre"}) {
		t.Fatalf("detail fallback tags=%v", detail.Tags)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	inherited, err := metadatatags.Read(ctx, db, work)
	if err != nil || len(inherited) != 1 {
		t.Fatalf("snapshot normalization=%v, %v", inherited, err)
	}
	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: inherited[0].ID, Action: "remove"}}, 0); err != nil {
		t.Fatal(err)
	}
	if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	tags, projected, err = s.loadProjectedDLsiteTags(ctx, work)
	if err != nil || !projected || tags == nil || len(tags) != 0 {
		t.Fatalf("authoritative empty tags=%v, %v, %v", tags, projected, err)
	}
	batch, err = s.loadProjectedDLsiteTagsBatch(ctx, []int64{work}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if tags, exists := batch[work]; !exists || len(tags) != 0 {
		t.Fatalf("empty card projection=%v", batch)
	}
	detail = workDetail{ID: work, PrimaryCode: code}
	if _, err := s.populateWorkDetailMetadata(ctx, &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Tags) != 0 {
		t.Fatalf("removed tags reappeared through snapshot fallback: %v", detail.Tags)
	}
}
