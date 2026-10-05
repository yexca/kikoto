package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestHiddenNameCreationReturnsExplicitConflictAndKeepsDraftAtomic(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	ctx := context.Background()
	actor := metadataReviewExec(t, db, "INSERT INTO user_account(username,role) VALUES ('synthetic-admin','admin')")
	user := account.User{ID: actor, Permissions: account.PermissionsForRole("admin")}
	work := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES ('RJ00000000','Example Work')")
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	hidden, err := metadatatags.CreateTx(ctx, tx, "Example hidden", actor)
	if err != nil {
		t.Fatal(err)
	}
	alias, err := metadatatags.CreateTx(ctx, tx, "Example merged", actor)
	if err != nil {
		t.Fatal(err)
	}
	if err := metadatatags.MergeTx(ctx, tx, alias, hidden); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("UPDATE metadata_tag SET hidden=1 WHERE tag_id=?", hidden); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Example hidden", " example MERGED "} {
		for _, path := range []string{"/api/metadata/tags", fmt.Sprintf("/api/works/%d/metadata-tags", work)} {
			method, body := http.MethodPost, fmt.Sprintf(`{"name":%q}`, name)
			if path != "/api/metadata/tags" {
				method, body = http.MethodPut, fmt.Sprintf(`{"newTags":["Example unsaved",%q],"overrides":[]}`, name)
			}
			response := metadataReviewRequest(t, s, method, path, body, user)
			if response.Code != 409 || !strings.Contains(response.Body.String(), `"code":"metadata_tag_hidden"`) {
				t.Fatalf("%s = %d %s", path, response.Code, response.Body.String())
			}
		}
	}
	var orphans int
	if err := db.QueryRow("SELECT COUNT(*) FROM tag WHERE display_name='Example unsaved'").Scan(&orphans); err != nil || orphans != 0 {
		t.Fatalf("failed draft left tags=%d, %v", orphans, err)
	}
}

func TestLargeTagMergeRetainsOldLinksUntilBoundedRepairAndInvalidatesSearch(t *testing.T) {
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
	source, err := metadatatags.CreateTx(ctx, tx, "Example source", actor)
	if err != nil {
		t.Fatal(err)
	}
	target, err := metadatatags.CreateTx(ctx, tx, "Example target", actor)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 150; i++ {
		result, err := tx.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Example Work')", testfixture.WorkCodeAt(i))
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		if err := metadatatags.SetOverridesTx(ctx, tx, id, []metadatatags.Override{{TagID: source, Action: "add"}}, actor); err != nil {
			t.Fatal(err)
		}
		if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, id, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	metadataReviewExec(t, db, "DELETE FROM work_search_dirty")
	metadataReviewExec(t, db, "CREATE TRIGGER example_no_inline_projection BEFORE UPDATE ON work_metadata_tag_projection BEGIN SELECT RAISE(ABORT,'Example inline projection'); END")
	response := metadataReviewRequest(t, s, http.MethodPost, fmt.Sprintf("/api/metadata/tags/%d/merge", source), fmt.Sprintf(`{"targetTagId":%d}`, target), user)
	if response.Code != 200 {
		t.Fatalf("large merge=%d %s", response.Code, response.Body.String())
	}
	var tag metadatatags.Tag
	if err := json.NewDecoder(response.Body).Decode(&tag); err != nil || tag.PendingWorkCount != 150 {
		t.Fatalf("pending count=%d %v", tag.PendingWorkCount, err)
	}
	var oldLinks int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_tag WHERE tag_id=?", source).Scan(&oldLinks); err != nil || oldLinks != 150 {
		t.Fatalf("pending source links=%d %v", oldLinks, err)
	}
	tags, err := metadatatags.Read(ctx, db, 1)
	if err != nil || len(tags) != 1 || tags[0].ID != source {
		t.Fatalf("merge made tags disappear=%v %v", tags, err)
	}
	metadataReviewExec(t, db, "DROP TRIGGER example_no_inline_projection")
	metadataReviewExec(t, db, "DELETE FROM work_search_dirty")
	var before, after int64
	if err := db.QueryRow("SELECT revision FROM recommendation_input_revision WHERE id=1").Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, limit := range []int{64, 64, 64} {
		if n, err := metasync.ProcessMetadataTagQueue(ctx, db, limit, nil); err != nil || n > 64 || n == 0 {
			t.Fatalf("bounded repair=%d %v", n, err)
		}
	}
	var queued, newLinks, dirty int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty").Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_tag WHERE tag_id=?", target).Scan(&newLinks); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_search_dirty").Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT revision FROM recommendation_input_revision WHERE id=1").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if queued != 0 || newLinks != 150 || dirty != 150 || after <= before {
		t.Fatalf("convergence queue=%d links=%d search=%d revision=%d/%d", queued, newLinks, dirty, before, after)
	}
	if n, err := metasync.ProcessMetadataTagQueue(ctx, db, 64, nil); err != nil || n != 0 {
		t.Fatalf("repeat repair=%d %v", n, err)
	}
}
