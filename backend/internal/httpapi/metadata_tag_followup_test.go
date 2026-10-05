package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestSnapshotWritesRetainCommittedEmptyTagsBeforeQueueRepair(t *testing.T) {
	for _, emptyBy := range []string{"remove", "hide"} {
		for _, provider := range []string{"dlsite", "example_remote_a"} {
			for _, change := range []string{"insert", "update", "delete"} {
				t.Run(emptyBy+"/"+provider+"/"+change, func(t *testing.T) {
					db := openMigratedTestDB(t)
					s := NewServer(db, config.Config{})
					ctx := context.Background()
					work := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES ('RJ00000000','Example Work')")
					metadataReviewExec(t, db, "INSERT INTO metadata_provider(code,display_name) VALUES ('example_remote_a','Example Remote A')")
					insertProjectionSnapshot(t, db, work, "2026-01-01 00:00:00", `{"product":{"genres":[{"id":1,"name":"Example provider tag"}]}}`)
					metadataReviewExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,'RJ00000000','{\"tags\":[\"Example remote tag\"]}' FROM metadata_provider WHERE code='example_remote_a'", work)
					if _, err := metasync.ProcessMetadataTagQueue(ctx, db, 64, nil); err != nil {
						t.Fatal(err)
					}
					tags, err := metadatatags.Read(ctx, db, work)
					if err != nil || len(tags) != 1 {
						t.Fatalf("initial tags: %v %v", tags, err)
					}
					tx, err := db.Begin()
					if err != nil {
						t.Fatal(err)
					}
					defer func() { _ = tx.Rollback() }()
					if emptyBy == "remove" {
						if err := metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: tags[0].ID, Action: "remove"}}, 0); err != nil {
							t.Fatal(err)
						}
					} else {
						if _, err := tx.Exec("UPDATE metadata_tag SET hidden=1 WHERE tag_id=?", tags[0].ID); err != nil {
							t.Fatal(err)
						}
					}
					if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
						t.Fatal(err)
					}
					if err := tx.Commit(); err != nil {
						t.Fatal(err)
					}
					switch change {
					case "insert":
						metadataReviewExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,request_locale,snapshot_json) SELECT ?,provider_id,'RJ00000000','en-us',snapshot_json FROM metadata_snapshot WHERE work_id=? AND provider_id=(SELECT id FROM metadata_provider WHERE code=?) LIMIT 1", work, work, provider)
					case "update":
						metadataReviewExec(t, db, "UPDATE metadata_snapshot SET snapshot_json=snapshot_json WHERE work_id=? AND provider_id=(SELECT id FROM metadata_provider WHERE code=?)", work, provider)
					case "delete":
						metadataReviewExec(t, db, "DELETE FROM metadata_snapshot WHERE work_id=? AND provider_id=(SELECT id FROM metadata_provider WHERE code=?)", work, provider)
					}
					var pending int
					if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty WHERE work_id=?", work).Scan(&pending); err != nil || pending != 1 {
						t.Fatalf("snapshot not queued: %d %v", pending, err)
					}
					shown, projected, err := s.loadProjectedDLsiteTags(ctx, work)
					if err != nil || !projected || len(shown) != 0 {
						t.Fatalf("pending empty result: %v %v %v", shown, projected, err)
					}
					batch, err := s.loadProjectedDLsiteTagsBatch(ctx, []int64{work}, map[int64][]string{work: {"Example raw tag"}})
					if err != nil {
						t.Fatal(err)
					}
					if shown, ok := batch[work]; !ok || len(shown) != 0 {
						t.Fatalf("empty card became raw: %v", batch)
					}
					detail := workDetail{ID: work, PrimaryCode: "RJ00000000"}
					if _, err := s.populateWorkDetailMetadata(ctx, &detail); err != nil || len(detail.Tags) != 0 {
						t.Fatalf("empty detail became raw: %v %v", detail.Tags, err)
					}
				})
			}
		}
	}
}

func TestRemoteCatalogTagsAndManualSharedTagsAreCombined(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	ctx := context.Background()
	work := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES ('RJ00000000','Example Remote Work')")
	metadataReviewExec(t, db, "INSERT INTO metadata_provider(code,display_name) VALUES ('example_remote_a','Example Remote A')")
	metadataReviewExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,'RJ00000000','{\"tags\":[\"Example remote tag\"]}' FROM metadata_provider WHERE code='example_remote_a'", work)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	id, err := metadatatags.CreateTx(ctx, tx, "Example manual tag", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: id, Action: "add"}}, 0); err != nil {
		t.Fatal(err)
	}
	if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	row := voiceCatalogMatchRow{ItemWorkID: sql.NullInt64{Int64: work, Valid: true}, TagsJSON: `["Example remote tag","Example manual tag"]`}
	item, err := s.buildVoiceCatalogRemoteWork(ctx, row, "RJ00000000", "ok", nil, nil)
	want := []string{"Example remote tag", "Example manual tag"}
	if err != nil || !reflect.DeepEqual(item.Tags, want) {
		t.Fatalf("remote catalog tags: %v %v", item.Tags, err)
	}
	batch, err := s.loadProjectedDLsiteTagsBatch(ctx, []int64{work}, map[int64][]string{work: {"Example remote tag"}})
	if err != nil || !reflect.DeepEqual(batch[work], want) {
		t.Fatalf("remote card tags: %v %v", batch, err)
	}
}

func TestTagCompletionCollapsesMergedAliasesIntoFinalTargetIncludingHiddenMatches(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	ctx := context.Background()
	actor := metadataReviewExec(t, db, "INSERT INTO user_account(username,role) VALUES ('synthetic-admin','admin')")
	user := account.User{ID: actor, Permissions: account.PermissionsForRole("admin")}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	ids := []int64{}
	for _, name := range []string{"Example alias one", "Example alias two", "Example final target"} {
		id, err := metadatatags.CreateTx(ctx, tx, name, 0)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	for _, pair := range [][2]int64{{ids[0], ids[1]}, {ids[1], ids[2]}} {
		if err := metadatatags.MergeTx(ctx, tx, pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, hidden := range []bool{false, true} {
		metadataReviewExec(t, db, "UPDATE metadata_tag SET hidden=? WHERE tag_id=?", hidden, ids[2])
		response := metadataReviewRequest(t, s, http.MethodGet, "/api/metadata/tags?q=Example&includeHidden=true&resolveMerged=true", "", user)
		var page metadataTagPage
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil || page.Total != 1 || len(page.Tags) != 1 {
			t.Fatalf("completion results: %d %s", response.Code, response.Body.String())
		}
		tag := page.Tags[0]
		if tag.ID != ids[2] || tag.DisplayName != "Example final target" || tag.ResolvedHidden != hidden || tag.MergedInto != nil {
			t.Fatalf("completion target: %+v", tag)
		}
		found := false
		for _, name := range tag.Names {
			if name.Name == "Example alias one" {
				found = true
			}
		}
		if !found {
			t.Fatal("old exact name no longer resolves in completion")
		}
	}
	response := metadataReviewRequest(t, s, http.MethodGet, "/api/metadata/tags?includeHidden=true", "", user)
	var page metadataTagPage
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil || page.Total != 3 {
		t.Fatalf("management lost original entries: %d %s", response.Code, response.Body.String())
	}
}

func TestMetadataTagQueueWorkerDrainsBacklogWithoutTickPerBatch(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	for i := 0; i < 96; i++ {
		result, err := tx.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Example Work')", testfixture.WorkCode(testfixture.PrefixRJ, i))
		if err != nil {
			t.Fatal(err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec("INSERT INTO work_metadata_tag_dirty(work_id) VALUES (?)", id); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); s.runMetadataTagQueueWorker(ctx) }()
	defer func() { cancel(); <-done }()
	for {
		var pending int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM work_metadata_tag_dirty").Scan(&pending); err != nil {
			t.Fatalf("backlog did not drain without per-batch ticks: %v", err)
		}
		if pending == 0 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(fmt.Errorf("backlog still contains %d works: %w", pending, ctx.Err()))
		case <-time.After(10 * time.Millisecond):
		}
	}
}
