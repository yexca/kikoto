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
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000000', 'Tagged work')")
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
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000001', 'Handler work')")
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
	workResult, _ := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000002', 'Add tag work')")
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

func TestListUserTagVocabularyReturnsAssignedTagsPerScope(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	userResult, _ := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('tag-vocab', 'Tag Vocab', 'user')")
	userID, _ := userResult.LastInsertId()
	otherResult, _ := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('tag-other', 'Tag Other', 'user')")
	otherID, _ := otherResult.LastInsertId()
	firstResult, _ := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000003', 'Vocabulary work one')")
	firstWorkID, _ := firstResult.LastInsertId()
	secondResult, _ := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000004', 'Vocabulary work two')")
	secondWorkID, _ := secondResult.LastInsertId()
	if _, err := db.Exec("INSERT INTO party (id, display_name) VALUES (9501, 'Vocabulary circle')"); err != nil {
		t.Fatal(err)
	}
	if _, err := server.replaceWorkUserTags(ctx, userID, firstWorkID, []string{"Sleep", "Focus"}); err != nil {
		t.Fatal(err)
	}
	if _, err := server.replaceWorkUserTags(ctx, userID, secondWorkID, []string{"Sleep", "Removed"}); err != nil {
		t.Fatal(err)
	}
	// Removing a tag from its last work drops it from the suggestions.
	if _, err := server.replaceWorkUserTags(ctx, userID, secondWorkID, []string{"Sleep"}); err != nil {
		t.Fatal(err)
	}
	if _, err := server.replaceWorkUserTags(ctx, otherID, firstWorkID, []string{"Private"}); err != nil {
		t.Fatal(err)
	}
	if _, err := server.replaceCircleUserTags(ctx, userID, 9501, []string{"Circle only"}); err != nil {
		t.Fatal(err)
	}

	list := func(scope string) (int, []userTagVocabularyEntry) {
		request := httptest.NewRequest(http.MethodGet, "/api/tags?scope="+scope, nil)
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{
			ID: userID, Permissions: []string{"library:read"},
		}))
		response := httptest.NewRecorder()
		server.listUserTagVocabulary(response, request)
		var payload struct {
			Tags []userTagVocabularyEntry `json:"tags"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &payload)
		return response.Code, payload.Tags
	}

	status, workTags := list("work")
	if status != http.StatusOK || len(workTags) != 2 ||
		workTags[0].Name != "Sleep" || workTags[0].UsageCount != 2 ||
		workTags[1].Name != "Focus" || workTags[1].UsageCount != 1 {
		t.Fatalf("work vocabulary = %d %#v", status, workTags)
	}
	status, circleTags := list("circle")
	if status != http.StatusOK || len(circleTags) != 1 || circleTags[0].Name != "Circle only" {
		t.Fatalf("circle vocabulary = %d %#v", status, circleTags)
	}
	status, voiceTags := list("voice")
	if status != http.StatusOK || len(voiceTags) != 0 {
		t.Fatalf("voice vocabulary = %d %#v", status, voiceTags)
	}
	if status, _ := list("user_tag"); status != http.StatusBadRequest {
		t.Fatalf("unknown scope status = %d", status)
	}
}

func TestCreatorUserTagsTruncateByCharacter(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	userResult, _ := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('tag-runes', 'Tag Runes', 'user')")
	userID, _ := userResult.LastInsertId()
	if _, err := db.Exec("INSERT INTO party (id, display_name) VALUES (9502, 'Rune circle')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO person (id, display_name) VALUES (9503, 'Rune voice')"); err != nil {
		t.Fatal(err)
	}
	// 45 three-byte characters: a 40-byte cut would split the fourteenth one.
	long := strings.Repeat("睡", 45)
	want := strings.Repeat("睡", 40)

	circleTags, err := server.replaceCircleUserTags(ctx, userID, 9502, []string{long})
	if err != nil {
		t.Fatal(err)
	}
	voiceTags, err := server.replaceVoiceUserTags(ctx, userID, 9503, []string{long})
	if err != nil {
		t.Fatal(err)
	}
	for scope, tags := range map[string][]voiceUserTag{"circle": circleTags, "voice": voiceTags} {
		if len(tags) != 1 || tags[0].Name != want {
			t.Fatalf("%s tags = %#v, want one tag of 40 characters", scope, tags)
		}
	}
}
