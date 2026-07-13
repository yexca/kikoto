package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestReplaceWorkUserTagsDeduplicatesAndLoadsBatch(t *testing.T) {
	db := openMigratedTestDB(t)
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('tag-user', 'Tag User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999001', 'Tagged work')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	server := NewServer(db, config.Config{})

	tags, err := server.replaceWorkUserTags(context.Background(), userID, workID, []string{" Sleep ", "sleep", "夜用"})
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 2 || tags[0].Name != "Sleep" || tags[1].Name != "夜用" {
		t.Fatalf("replaceWorkUserTags() = %#v", tags)
	}
	batch, err := server.loadWorkUserTagsBatch(context.Background(), userID, []int64{workID, workID + 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(batch[workID]) != 2 || batch[workID+100] == nil {
		t.Fatalf("loadWorkUserTagsBatch() = %#v", batch)
	}
}

func TestSetWorkUserTagsReturnsUserTags(t *testing.T) {
	db := openMigratedTestDB(t)
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('tag-handler', 'Tag Handler', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999002', 'Handler work')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPut, "/api/works/1/tags", strings.NewReader(`{"tags":["Focus","Night"]}`))
	request.SetPathValue("id", strconv.FormatInt(workID, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{
		ID: userID, Permissions: []string{"tags:write"},
	}))
	response := httptest.NewRecorder()

	server.setWorkUserTags(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("set work tags status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		WorkID   int64         `json:"workId"`
		UserTags []workUserTag `json:"userTags"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.WorkID != workID || len(payload.UserTags) != 2 {
		t.Fatalf("set work tags response = %#v", payload)
	}
}

func TestAddWorkUserTagPreservesExistingTagsAndIsIdempotent(t *testing.T) {
	db := openMigratedTestDB(t)
	userResult, _ := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('tag-add', 'Tag Add', 'user')")
	userID, _ := userResult.LastInsertId()
	workResult, _ := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999003', 'Add tag work')")
	workID, _ := workResult.LastInsertId()
	server := NewServer(db, config.Config{})
	if _, err := server.replaceWorkUserTags(context.Background(), userID, workID, []string{"Existing"}); err != nil {
		t.Fatal(err)
	}
	added, err := server.addWorkUserTag(context.Background(), userID, []int64{workID, workID}, " Popular ")
	if err != nil || added != 1 {
		t.Fatalf("first add = %d, %v", added, err)
	}
	added, err = server.addWorkUserTag(context.Background(), userID, []int64{workID}, "popular")
	if err != nil || added != 0 {
		t.Fatalf("second add = %d, %v", added, err)
	}
	tags, err := server.loadWorkUserTags(context.Background(), userID, workID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 2 || tags[0].Name != "Existing" || tags[1].Name != "Popular" {
		t.Fatalf("tags = %#v", tags)
	}
}
