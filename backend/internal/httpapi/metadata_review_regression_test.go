package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/circleidentity"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func metadataReviewExec(t *testing.T, db *sql.DB, query string, args ...any) int64 {
	t.Helper()
	result, err := db.Exec(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func metadataReviewRequest(t *testing.T, s *Server, method, path, body string, user account.User) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), currentUserKey, user))
	parts := strings.Split(strings.Trim(path, "/"), "/")
	w := httptest.NewRecorder()
	switch {
	case strings.HasPrefix(path, "/api/works/"):
		r.SetPathValue("id", parts[2])
		s.setWorkMetadataTags(w, r)
	case strings.HasPrefix(path, "/api/metadata/circles/"):
		r.SetPathValue("partyId", parts[3])
		s.getMetadataCircle(w, r)
	case path == "/api/metadata/circles":
		s.listMetadataCircles(w, r)
	case path == "/api/metadata/tags":
		if method == http.MethodGet {
			s.listMetadataTags(w, r)
		} else {
			s.changeMetadataTag(w, r)
		}
	default:
		r.SetPathValue("tagId", parts[3])
		s.changeMetadataTag(w, r)
	}
	return w
}

func TestTagChangesProjectOnlyConnectedReferencesAndRollbackAsOneUnit(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	actor := metadataReviewExec(t, db, "INSERT INTO user_account(username,role) VALUES ('synthetic-tag-review','admin')")
	user := account.User{ID: actor, Permissions: account.PermissionsForRole("admin")}
	var works []int64
	for ordinal := 0; ordinal < 5; ordinal++ {
		works = append(works, metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Synthetic scoped work')", testfixture.WorkCode(testfixture.PrefixRJ, ordinal)))
	}
	ctx := context.Background()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','Synthetic source genre')"); err != nil {
		t.Fatal(err)
	}
	source, err := metadatatags.EnsureGenreTx(ctx, tx, 1)
	if err != nil {
		t.Fatal(err)
	}
	target, err := metadatatags.CreateTx(ctx, tx, "Synthetic target", actor)
	if err != nil {
		t.Fatal(err)
	}
	other, err := metadatatags.CreateTx(ctx, tx, "Synthetic unrelated", actor)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,1)", works[0]); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		work      int64
		overrides []metadatatags.Override
	}{
		{works[1], []metadatatags.Override{{TagID: source, Action: "add"}}},
		{works[2], []metadatatags.Override{{TagID: source, Action: "remove"}, {TagID: other, Action: "add"}}},
		{works[3], []metadatatags.Override{{TagID: target, Action: "add"}}},
	} {
		if err := metadatatags.SetOverridesTx(ctx, tx, fixture.work, fixture.overrides, actor); err != nil {
			t.Fatal(err)
		}
	}
	for _, work := range works {
		if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	metadataReviewExec(t, db, "INSERT INTO app_setting(key,value_json) VALUES ('metadata_tag_projection_version','1')")
	metadataReviewExec(t, db, "CREATE TABLE review_projection_trace(work_id INTEGER)")
	metadataReviewExec(t, db, "CREATE TRIGGER review_projection_update AFTER UPDATE ON work_metadata_tag_projection BEGIN INSERT INTO review_projection_trace VALUES(new.work_id); END")
	metadataReviewExec(t, db, fmt.Sprintf("CREATE TRIGGER review_unrelated_guard BEFORE UPDATE ON work_metadata_tag_projection WHEN new.work_id=%d BEGIN SELECT RAISE(ABORT,'unrelated work was projected'); END", works[4]))
	check := func(method, path, body string, want []int64) {
		t.Helper()
		metadataReviewExec(t, db, "DELETE FROM review_projection_trace")
		response := metadataReviewRequest(t, s, method, path, body, user)
		if response.Code != 200 {
			t.Fatalf("change %s: %d %s", path, response.Code, response.Body.String())
		}
		rows, err := db.Query("SELECT work_id FROM review_projection_trace ORDER BY work_id")
		if err != nil {
			t.Fatal(err)
		}
		got := []int64{}
		for rows.Next() {
			var work int64
			if err := rows.Scan(&work); err != nil {
				t.Fatal(err)
			}
			got = append(got, work)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
		sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("projected %v, want only %v", got, want)
		}
		var marker string
		if err := db.QueryRow("SELECT value_json FROM app_setting WHERE key='metadata_tag_projection_version'").Scan(&marker); err != nil || marker != "1" {
			t.Fatalf("completion marker %q, %v", marker, err)
		}
	}
	path := fmt.Sprintf("/api/metadata/tags/%d", source)
	check(http.MethodPatch, path, `{"hidden":true}`, append([]int64{}, works[:3]...))
	check(http.MethodPatch, path, `{"hidden":false}`, append([]int64{}, works[:3]...))
	check(http.MethodPost, path+"/merge", fmt.Sprintf(`{"targetTagId":%d}`, target), append([]int64{}, works[:4]...))
	check(http.MethodDelete, path+"/merge", "", append([]int64{}, works[:4]...))
	// A failure during any projection rolls back the state and all earlier
	// projection writes, with the global completion marker untouched.
	metadataReviewExec(t, db, fmt.Sprintf("CREATE TRIGGER review_projection_failure BEFORE UPDATE ON work_metadata_tag_projection WHEN new.work_id=%d BEGIN SELECT RAISE(ABORT,'synthetic projection interruption'); END", works[2]))
	response := metadataReviewRequest(t, s, http.MethodPatch, path, `{"hidden":true}`, user)
	if response.Code < 400 {
		t.Fatalf("interrupted change succeeded: %s", response.Body.String())
	}
	var hidden bool
	if err := db.QueryRow("SELECT hidden FROM metadata_tag WHERE tag_id=?", source).Scan(&hidden); err != nil || hidden {
		t.Fatalf("partial hidden state = %v, %v", hidden, err)
	}
	tags, err := metadatatags.Read(ctx, db, works[0])
	if err != nil || len(tags) != 1 || tags[0].ID != source {
		t.Fatalf("partial projection = %v, %v", tags, err)
	}
}

func TestWorkTagDraftCreationIsAtomicAndDeduplicatedByAnyKnownName(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	actor := metadataReviewExec(t, db, "INSERT INTO user_account(username,role) VALUES ('synthetic-draft-review','admin')")
	user := account.User{ID: actor, Permissions: account.PermissionsForRole("admin")}
	work := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Synthetic draft work')", testfixture.WorkCode(testfixture.PrefixRJ, 0))
	path := fmt.Sprintf("/api/works/%d/metadata-tags", work)
	response := metadataReviewRequest(t, s, http.MethodPut, path, `{"newTags":["Synthetic draft"," synthetic DRAFT "],"overrides":[]}`, user)
	if response.Code != 200 {
		t.Fatalf("draft save: %d %s", response.Code, response.Body.String())
	}
	var state workMetadataTags
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Tags) != 1 || len(state.Overrides) != 1 {
		t.Fatalf("duplicate drafts = %+v", state)
	}
	tag := state.Tags[0].ID
	metadataReviewExec(t, db, "INSERT INTO metadata_tag_name(tag_id,language,name) VALUES (?,'zh-cn','合成草稿名称')", tag)
	response = metadataReviewRequest(t, s, http.MethodPut, path, `{"newTags":[" 合成草稿名称 "],"overrides":[]}`, user)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Tags) != 1 || state.Tags[0].ID != tag {
		t.Fatalf("language-name reuse = %+v", state)
	}
	response = metadataReviewRequest(t, s, http.MethodPut, path, `{"newTags":["Synthetic rolled back"],"overrides":[{"tagId":999999,"action":"add"}]}`, user)
	if response.Code < 400 {
		t.Fatal("invalid override accepted")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_tag").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("failed save left %d concepts", count)
	}
	// The standalone shared-entry creation endpoint enforces the same rule.
	response = metadataReviewRequest(t, s, http.MethodPost, "/api/metadata/tags", `{"name":" SYNTHETIC DRAFT "}`, user)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var entry metadatatags.Tag
	if err := json.Unmarshal(response.Body.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.ID != tag {
		t.Fatalf("standalone duplicate id = %d, want %d", entry.ID, tag)
	}
}

func TestTagChangeDeadlineCancelsDatabaseWaitWithoutPartialState(t *testing.T) {
	db := openMigratedTestDBWithProductionPool(t)
	s := NewServer(db, config.Config{})
	actor := metadataReviewExec(t, db, "INSERT INTO user_account(username,role) VALUES ('synthetic-timeout-review','admin')")
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	tag, err := metadatatags.CreateTx(context.Background(), tx, "Synthetic timeout tag", actor)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	blocker, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback() }()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	request := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/metadata/tags/%d", tag), strings.NewReader(`{"hidden":true}`))
	request.SetPathValue("tagId", fmt.Sprint(tag))
	request = request.WithContext(context.WithValue(ctx, currentUserKey, account.User{ID: actor, Permissions: account.PermissionsForRole("admin")}))
	response := httptest.NewRecorder()
	finished := make(chan struct{})
	go func() { defer close(finished); s.changeMetadataTag(response, request) }()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		_ = blocker.Rollback()
		<-finished
		t.Fatal("tag change exceeded its context deadline while waiting for a writer")
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("deadline status=%d, body=%s", response.Code, response.Body.String())
	}
	var hidden bool
	if err := db.QueryRow("SELECT hidden FROM metadata_tag WHERE tag_id=?", tag).Scan(&hidden); err != nil || hidden {
		t.Fatalf("canceled change state=%v, %v", hidden, err)
	}
}

func TestMetadataEntryReadsRespectPagePermissionsDemoScopeAndCircleVisibility(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var works []int64
	for ordinal := 0; ordinal < 3; ordinal++ {
		works = append(works, metadataReviewExec(t, db, "INSERT INTO work(primary_code,title,age_rating,is_permanently_free) VALUES (?,'Synthetic visible work',?,?)", testfixture.WorkCode(testfixture.PrefixRJ, ordinal), []string{"general", "general", "adult"}[ordinal], ordinal != 1))
	}
	visible := metadataReviewExec(t, db, "INSERT INTO party(party_type,display_name) VALUES ('circle','Synthetic public circle')")
	private := metadataReviewExec(t, db, "INSERT INTO party(party_type,display_name) VALUES ('circle','Synthetic private circle')")
	translator := metadataReviewExec(t, db, "INSERT INTO party(party_type,display_name) VALUES ('circle','Synthetic translation party')")
	metadataReviewExec(t, db, "INSERT INTO work_party(work_id,party_id,role,source) VALUES (?,?,'circle','dlsite'),(?,?,'circle','dlsite'),(?,?,'circle','dlsite'),(?,?,'translator_circle','dlsite')", works[0], visible, works[1], visible, works[2], private, works[0], translator)
	metadataReviewExec(t, db, "INSERT INTO party_external_id(party_id,provider_id,id_type,external_id) SELECT ?,id,'maker_id','RG00000000' FROM metadata_provider WHERE code='dlsite'", visible)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	publicTag, err := metadatatags.CreateTx(ctx, tx, "Synthetic public tag", 0)
	if err != nil {
		t.Fatal(err)
	}
	privateTag, err := metadatatags.CreateTx(ctx, tx, "Synthetic private tag", 0)
	if err != nil {
		t.Fatal(err)
	}
	for i, work := range works {
		id := publicTag
		if i == 2 {
			id = privateTag
		}
		if err := metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: id, Action: "add"}}, 0); err != nil {
			t.Fatal(err)
		}
		if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	paths := []string{"/api/metadata/circles", fmt.Sprintf("/api/metadata/circles/%d", visible), fmt.Sprintf("/api/metadata/circles/%d/merges", visible), "/api/metadata/tags"}
	regular := NewServer(db, config.Config{})
	metadataReviewExec(t, db, "INSERT INTO app_setting(key,value_json) VALUES ('anonymous_access_enabled','true')")
	if err := regular.LoadAccessPolicy(ctx); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		response := httptest.NewRecorder()
		regular.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous management read %s: %d", path, response.Code)
		}
	}
	for _, path := range paths {
		for _, user := range []account.User{{}, {ID: 1, Permissions: []string{"library:read"}}} {
			response := metadataReviewRequest(t, regular, http.MethodGet, path, "", user)
			want := 403
			if user.ID == 0 {
				want = 401
			}
			if response.Code != want {
				t.Fatalf("read %s status=%d, want %d", path, response.Code, want)
			}
		}
		// Library writers can still use editor autocomplete without sync rights.
		response := metadataReviewRequest(t, regular, http.MethodGet, path, "", account.User{ID: 1, Permissions: []string{"library:read", "library:write"}})
		if response.Code != 200 {
			t.Fatalf("writer read %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	demo := NewServer(db, config.Config{Mode: config.ModeDemo})
	user := account.User{ID: 1, Permissions: []string{"library:read"}}
	response := metadataReviewRequest(t, demo, http.MethodGet, "/api/metadata/circles", "", user)
	var circles struct {
		Circles []circleidentity.Circle
		Total   int
	}
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &circles); err != nil {
		t.Fatal(err)
	}
	if circles.Total != 1 || len(circles.Circles) != 1 || circles.Circles[0].ID != visible || circles.Circles[0].WorkCount != 1 {
		t.Fatalf("demo circles = %+v", circles)
	}
	response = metadataReviewRequest(t, demo, http.MethodGet, "/api/metadata/tags", "", user)
	var tags metadataTagPage
	if err := json.Unmarshal(response.Body.Bytes(), &tags); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || tags.Total != 1 || len(tags.Tags) != 1 || tags.Tags[0].ID != publicTag || tags.Tags[0].WorkCount != 1 {
		t.Fatalf("demo tags = %+v, status %d", tags, response.Code)
	}
	for _, id := range []int64{private, translator} {
		for _, suffix := range []string{"", "/merges"} {
			response = metadataReviewRequest(t, demo, http.MethodGet, fmt.Sprintf("/api/metadata/circles/%d%s", id, suffix), "", user)
			if response.Code != 404 {
				t.Fatalf("invisible circle %d%s: %d", id, suffix, response.Code)
			}
		}
	}
	response = metadataReviewRequest(t, regular, http.MethodGet, fmt.Sprintf("/api/metadata/circles/%d", translator), "", account.User{ID: 1, Permissions: []string{"library:write"}})
	if response.Code != 404 {
		t.Fatalf("translator-only circle leaked: %d %s", response.Code, response.Body.String())
	}
	response = metadataReviewRequest(t, demo, http.MethodGet, fmt.Sprintf("/api/metadata/circles/%d", visible), "", user)
	var detail circleidentity.Circle
	if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || detail.WorkCount != 1 {
		t.Fatalf("demo detail=%+v, status %d", detail, response.Code)
	}
	response = metadataReviewRequest(t, demo, http.MethodGet, fmt.Sprintf("/api/metadata/circles/%d/merges", visible), "", user)
	if response.Code != 200 || strings.TrimSpace(response.Body.String()) != "[]" {
		t.Fatalf("demo merge history leaked: %d %s", response.Code, response.Body.String())
	}
}
