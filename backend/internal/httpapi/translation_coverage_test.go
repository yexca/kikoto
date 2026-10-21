package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func readTranslationCoverage(t *testing.T, s *Server, query string) map[string]translationCoverage {
	t.Helper()
	response := metadataRequest(s.listTranslationCoverage, http.MethodGet, "/api/metadata/translation-coverage?"+query, "", "metadata:sync")
	var page struct {
		Works []translationCoverageWork `json:"works"`
		Total int                       `json:"total"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != 200 || page.Total != len(page.Works) {
		t.Fatalf("%s: %d %s %v", query, response.Code, response.Body, err)
	}
	result := map[string]translationCoverage{}
	for _, work := range page.Works {
		result[work.PrimaryCode] = work.Translation
	}
	return result
}

// A family is covered by its own edition in the language; a lone work by its
// accepted translation, shared tag names, file display names and lyrics. Each
// missing filter lists the families lacking that part.
func TestTranslationCoverageReportsSourcesAndFiltersMissingParts(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	original, translated := testfixture.WorkCode(testfixture.PrefixRJ, 0), testfixture.WorkCode(testfixture.PrefixRJ, 1)
	lone, bare := testfixture.WorkCode(testfixture.PrefixRJ, 2), testfixture.WorkCode(testfixture.PrefixRJ, 3)
	expires := time.Now().Add(time.Hour).Unix()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO user_account(id,username,role) VALUES (1,'synthetic-user','admin')", nil},
		{"INSERT INTO work(id,primary_code,title) VALUES (1,?,'Synthetic original'),(2,?,'Synthetic edition'),(3,?,'Synthetic lone'),(4,?,'Synthetic bare')", []any{original, translated, lone, bare}},
		{"INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES (1,1,?)", []any{original}},
		{"INSERT INTO work_edition(work_id,logical_work_id,primary_code,metadata_language,is_canonical) VALUES (1,1,?,'JPN',1),(2,1,?,'CHI_HANS',0)", []any{original, translated}},
		{"INSERT INTO work_llm_translation(work_id,language,field_name,value_text,source_hash) VALUES (3,'zh-cn','title','合成标题','hash')", nil},
		{"INSERT INTO tag(id,namespace,normalized_name,display_name) VALUES (10,'metadata','synthetic-named','Synthetic named'),(11,'metadata','synthetic-unnamed','Synthetic unnamed')", nil},
		{"INSERT INTO metadata_tag(tag_id) VALUES (10),(11)", nil},
		{"INSERT INTO metadata_tag_name(tag_id,language,name) VALUES (10,'zh-cn','合成标签')", nil},
		{"INSERT INTO work_tag(work_id,tag_id,source) VALUES (3,10,'dlsite'),(3,11,'dlsite')", nil},
		{"INSERT INTO file_source(id,code,display_name,source_type) VALUES (1,'local','Local','local')", nil},
		{"INSERT INTO media_item(id,work_id,kind,title) VALUES (20,3,'audio','Track 01'),(21,3,'audio','Track 02'),(22,3,'text','Track 01')", nil},
		{"INSERT INTO media_file_location(media_item_id,file_source_id,location_type,path,availability) VALUES (20,1,'local','a/1.mp3','available'),(21,1,'local','a/2.mp3','available'),(22,1,'local','a/1.vtt','available')", nil},
		{"INSERT INTO media_item_display_name(media_item_id,language,name) VALUES (20,'zh-cn','第一轨')", nil},
		{"INSERT INTO media_lyrics_assignment(audio_media_item_id,language,lyrics_media_item_id) VALUES (20,'zh-cn',22)", nil},
		{"INSERT INTO llm_translation_preview(id,work_id,user_id,payload_json,expires_at) VALUES ('synthetic-preview',3,1,'{\"Target\":\"zh-cn\"}',?)", []any{expires}},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatalf("%s: %v", statement.query, err)
		}
	}

	all := readTranslationCoverage(t, s, "language=zh-cn&missing=all")
	if len(all) != 3 {
		t.Fatalf("families = %+v", all)
	}
	family := all[original]
	if family.OriginLanguage != "ja-jp" || family.Title != "edition" || family.Description != "edition" {
		t.Fatalf("family = %+v", family)
	}
	got := all[lone]
	want := translationCoverage{Title: "llm", Description: "missing", Tags: translationCount{1, 2},
		Files: translationCount{1, 3}, Lyrics: translationCount{1, 2}, Review: 1}
	if got != want {
		t.Fatalf("lone = %+v, want %+v", got, want)
	}
	if origin := readTranslationCoverage(t, s, "language=ja-jp&missing=all")[original]; origin.Title != "origin" {
		t.Fatalf("original language = %+v", origin)
	}

	for filter, codes := range map[string][]string{
		"title":       {bare},
		"description": {lone, bare},
		"tags":        {lone},
		"files":       {lone},
		"lyrics":      {lone},
		"any":         {lone, bare},
		"complete":    {original},
	} {
		listed := readTranslationCoverage(t, s, "language=zh-cn&missing="+filter)
		if len(listed) != len(codes) {
			t.Fatalf("%s lists %+v, want %v", filter, listed, codes)
		}
		for _, code := range codes {
			if _, ok := listed[code]; !ok {
				t.Fatalf("%s lists %+v, want %v", filter, listed, codes)
			}
		}
	}
}

func TestTranslationCoverageRequiresMetadataAccessAndValidLanguage(t *testing.T) {
	s := NewServer(openMigratedTestDB(t), config.Config{})
	if response := metadataRequest(s.listTranslationCoverage, http.MethodGet, "/api/metadata/translation-coverage?language=zh-cn", "", "library:read"); response.Code != http.StatusForbidden {
		t.Fatalf("reader = %d %s", response.Code, response.Body)
	}
	for _, query := range []string{"language=fr-fr", "language=zh-cn&missing=everything", "language=origin"} {
		if response := metadataRequest(s.listTranslationCoverage, http.MethodGet, "/api/metadata/translation-coverage?"+query, "", "metadata:sync"); response.Code != http.StatusBadRequest {
			t.Fatalf("%s = %d %s", query, response.Code, response.Body)
		}
	}
}
