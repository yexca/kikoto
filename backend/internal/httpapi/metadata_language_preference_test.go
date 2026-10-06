package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func metadataLanguageUser(t *testing.T, db *sql.DB, name string) (int64, context.Context) {
	t.Helper()
	id := metadataReviewExec(t, db, "INSERT INTO user_account (username, display_name, role) VALUES (?, ?, 'user')", name, name)
	return id, context.WithValue(context.Background(), currentUserKey, currentUser{ID: id, Role: "user"})
}

// setUserMetadataLanguages stores a user's personal metadata language
// priority directly, as a JSON list.
func setUserMetadataLanguages(t *testing.T, db *sql.DB, userID int64, languages string) {
	t.Helper()
	metadataReviewExec(t, db, `INSERT INTO user_preference (user_id, metadata_languages) VALUES (?, ?)
		ON CONFLICT(user_id) DO UPDATE SET metadata_languages = excluded.metadata_languages`, userID, languages)
}

// metadataLanguageViewer is a request context signed in as userID.
func metadataLanguageViewer(userID int64) context.Context {
	return context.WithValue(context.Background(), currentUserKey, currentUser{ID: userID, Role: "user"})
}

func patchMetadataLanguages(t *testing.T, server *Server, userID int64, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPatch, "/api/auth/me/preferences", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: userID, Role: "user"}))
	response := httptest.NewRecorder()
	server.updateUserPreferences(response, request)
	return response
}

func TestUserMetadataLanguageUsesOriginUntilChosen(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	chooser, chooserCtx := metadataLanguageUser(t, db, "synthetic-language-a")
	_, otherCtx := metadataLanguageUser(t, db, "synthetic-language-b")

	response := patchMetadataLanguages(t, server, chooser, `{"metadataLanguages":["zh-cn"]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("save: %d %s", response.Code, response.Body.String())
	}
	var saved userPreferences
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(saved.MetadataLanguages, []string{"zh-cn", "origin"}) {
		t.Fatalf("saved preferences = %+v", saved)
	}
	for _, check := range []struct {
		name string
		ctx  context.Context
		want []string
	}{
		{"chooser", chooserCtx, []string{"zh-cn", "origin"}},
		{"other user", otherCtx, []string{"origin"}},
		{"anonymous", context.Background(), []string{"origin"}},
	} {
		if got := server.viewerMetadataLanguages(check.ctx); !reflect.DeepEqual(got, check.want) {
			t.Fatalf("%s languages = %v, want %v", check.name, got, check.want)
		}
	}
	// A personal choice never changes the stored-metadata language.
	if got := server.instanceMetadataLanguages(context.Background()); !reflect.DeepEqual(got, []string{"origin"}) {
		t.Fatalf("instance languages = %v", got)
	}

	for _, body := range []string{
		`{"metadataLanguages":["xx-yy"]}`,
		`{"metadataLanguages":[]}`,
		`{"metadataLanguages":["ja-jp","en-us","zh-cn","zh-tw","ko-kr","ja-jp"]}`,
	} {
		if response := patchMetadataLanguages(t, server, chooser, body); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid list %s: %d %s", body, response.Code, response.Body.String())
		}
	}
	if response := patchMetadataLanguages(t, server, chooser, `{"recommendationThreshold":40}`); response.Code != http.StatusOK {
		t.Fatalf("unrelated update: %d %s", response.Code, response.Body.String())
	}
	if got := server.viewerMetadataLanguages(chooserCtx); !reflect.DeepEqual(got, []string{"zh-cn", "origin"}) {
		t.Fatalf("omitted field changed languages to %v", got)
	}
	if response := patchMetadataLanguages(t, server, chooser, `{"metadataLanguages":null}`); response.Code != http.StatusOK {
		t.Fatalf("clear choice: %d %s", response.Code, response.Body.String())
	}
	if got := server.viewerMetadataLanguages(chooserCtx); !reflect.DeepEqual(got, []string{"origin"}) {
		t.Fatalf("cleared choice languages = %v", got)
	}
	if got := server.learnedMetadataLanguages(context.Background()); !reflect.DeepEqual(got, []string{"origin"}) {
		t.Fatalf("learned languages after clearing = %v", got)
	}
}

// Choosing only the original language is no preference: it is stored as
// NULL, and the response carries no separate instance default.
func TestUserMetadataLanguageOriginOnlyIsStoredAsNoPreference(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	user, userCtx := metadataLanguageUser(t, db, "synthetic-language-origin-only")
	if response := patchMetadataLanguages(t, server, user, `{"metadataLanguages":["zh-cn"]}`); response.Code != http.StatusOK {
		t.Fatalf("save: %d %s", response.Code, response.Body.String())
	}
	response := patchMetadataLanguages(t, server, user, `{"metadataLanguages":["origin"]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("save origin: %d %s", response.Code, response.Body.String())
	}
	var stored sql.NullString
	if err := db.QueryRow("SELECT metadata_languages FROM user_preference WHERE user_id = ?", user).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored.Valid {
		t.Fatalf("origin-only choice stored %q, want NULL", stored.String)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/auth/me/preferences", nil).WithContext(userCtx)
	got := httptest.NewRecorder()
	server.getUserPreferences(got, request)
	if got.Code != http.StatusOK {
		t.Fatalf("get: %d %s", got.Code, got.Body.String())
	}
	for _, body := range []*httptest.ResponseRecorder{response, got} {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(body.Body.Bytes(), &fields); err != nil {
			t.Fatal(err)
		}
		if raw, ok := fields["metadataLanguages"]; !ok || string(raw) != "null" {
			t.Fatalf("metadataLanguages = %s (present %v), want null", raw, ok)
		}
		if _, ok := fields["defaultMetadataLanguages"]; ok {
			t.Fatalf("preferences still expose defaultMetadataLanguages: %s", body.Body.String())
		}
	}
}

// Two users see the same work in their own languages while the stored
// projection keeps the original language.
func TestViewerLanguageSelectsTitlesTagsAndEditionWithoutChangingStoredValues(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var provider int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code='dlsite'").Scan(&provider); err != nil {
		t.Fatal(err)
	}
	titles := []string{"Synthetic original title", "Synthetic Chinese title"}
	works := []int64{}
	for ordinal, title := range titles {
		works = append(works, metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,?)", testfixture.WorkCode(testfixture.PrefixRJ, 40+ordinal), title))
	}
	logical := metadataReviewExec(t, db, "INSERT INTO logical_work(canonical_work_id,canonical_code) VALUES (?,?)", works[0], testfixture.WorkCode(testfixture.PrefixRJ, 40))
	for ordinal, work := range works {
		code := testfixture.WorkCode(testfixture.PrefixRJ, 40+ordinal)
		language := []string{"JPN", "CHI_HANS"}[ordinal]
		locale := []string{"ja-jp", "zh-cn"}[ordinal]
		metadataReviewExec(t, db, "INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,metadata_language,is_canonical) VALUES (?,?,?,?,?,?)", work, logical, provider, code, language, ordinal == 0)
		metadataReviewExec(t, db, "INSERT INTO dlsite_metadata_variant(logical_work_id,work_id,provider_id,external_id,edition_language,request_locale,title,tags_json) VALUES (?,?,?,?,?,?,?,'[]')", logical, work, provider, code, language, locale, titles[ordinal])
		metadataReviewExec(t, db, "INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,1)", work)
	}
	// The Chinese edition also carries a genre the original lacks; the
	// family's shared tags still come from the original edition.
	metadataReviewExec(t, db, "INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,2)", works[1])
	metadataReviewExec(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','合成日本語タグ'),(1,'zh-cn','合成中文标签'),(2,'ja-jp','追加タグ')")
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for _, genre := range []int64{1, 2} {
		if _, err := metadatatags.EnsureGenreTx(ctx, tx, genre); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := metasync.ProjectDLsiteMetadata(ctx, db, []string{"origin"}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	chineseUser, chineseCtx := metadataLanguageUser(t, db, "synthetic-language-zh")
	_, originCtx := metadataLanguageUser(t, db, "synthetic-language-origin")
	if response := patchMetadataLanguages(t, server, chineseUser, `{"metadataLanguages":["zh-cn"]}`); response.Code != http.StatusOK {
		t.Fatalf("save: %d %s", response.Code, response.Body.String())
	}

	for _, viewer := range []struct {
		name                string
		ctx                 context.Context
		title, tag, edition string
	}{
		{"Chinese viewer", withMetadataLanguageMemo(chineseCtx), "Synthetic Chinese title", "合成中文标签", testfixture.WorkCode(testfixture.PrefixRJ, 41)},
		{"origin viewer", withMetadataLanguageMemo(originCtx), "Synthetic original title", "合成日本語タグ", testfixture.WorkCode(testfixture.PrefixRJ, 40)},
	} {
		titles, err := server.loadWorkTitles(viewer.ctx, []int64{works[0]})
		if err != nil {
			t.Fatal(err)
		}
		if titles[works[0]].Title != viewer.title {
			t.Fatalf("%s title = %q, want %q", viewer.name, titles[works[0]].Title, viewer.title)
		}
		cards, err := server.loadProjectedDLsiteTagsBatch(viewer.ctx, []int64{works[0]}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(cards[works[0]], []string{viewer.tag}) {
			t.Fatalf("%s card tags = %v, want %s", viewer.name, cards[works[0]], viewer.tag)
		}
		detail, _, err := server.loadProjectedDLsiteTags(viewer.ctx, works[0])
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(detail, []string{viewer.tag}) {
			t.Fatalf("%s detail tags = %v, want %s", viewer.name, detail, viewer.tag)
		}
		editor, err := server.loadWorkMetadataTags(viewer.ctx, works[0])
		if err != nil {
			t.Fatal(err)
		}
		if len(editor.Tags) != 1 || editor.Tags[0].DisplayName != viewer.tag {
			t.Fatalf("%s editor tags = %+v", viewer.name, editor.Tags)
		}
		view, err := server.loadWorkMetadataPresentation(viewer.ctx, works[0])
		if err != nil {
			t.Fatal(err)
		}
		if view.DefaultVariantKey != viewer.edition {
			t.Fatalf("%s default edition = %s, want %s", viewer.name, view.DefaultVariantKey, viewer.edition)
		}
		for _, variant := range view.Variants {
			want := map[string]string{"ja-jp": "合成日本語タグ", "zh-cn": "合成中文标签"}[variant.Language]
			if !reflect.DeepEqual(variant.Tags, []string{want}) {
				t.Fatalf("%s %s version tags = %v, want %s", viewer.name, variant.Language, variant.Tags, want)
			}
		}
	}

	var storedTitle, storedTag string
	if err := db.QueryRow("SELECT title FROM work WHERE id=?", works[0]).Scan(&storedTitle); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT tag.display_name FROM tag JOIN metadata_tag AS concept ON concept.tag_id=tag.id WHERE concept.dlsite_genre_id=1").Scan(&storedTag); err != nil {
		t.Fatal(err)
	}
	if storedTitle != "Synthetic original title" || storedTag != "合成日本語タグ" {
		t.Fatalf("stored projection = %q / %q", storedTitle, storedTag)
	}
}
