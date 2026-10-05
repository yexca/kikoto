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

func TestMetadataLanguageVariantsLocalizeSharedTagsAndSelectProjectedSource(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var provider int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code='dlsite'").Scan(&provider); err != nil {
		t.Fatal(err)
	}
	works := []int64{}
	for ordinal := 0; ordinal < 3; ordinal++ {
		works = append(works, metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,?)", testfixture.WorkCode(testfixture.PrefixRJ, ordinal), "Synthetic title "+[]string{"Japanese", "Chinese", "English"}[ordinal]))
	}
	logical := metadataReviewExec(t, db, "INSERT INTO logical_work(canonical_work_id,canonical_code) VALUES (?,?)", works[0], testfixture.WorkCode(testfixture.PrefixRJ, 0))
	for ordinal, work := range works {
		code := testfixture.WorkCode(testfixture.PrefixRJ, ordinal)
		language := []string{"JPN", "CHI_HANS", "ENG"}[ordinal]
		locale := []string{"ja-jp", "zh-cn", "en-us"}[ordinal]
		metadataReviewExec(t, db, "INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,metadata_language,is_canonical) VALUES (?,?,?,?,?,?)", work, logical, provider, code, language, ordinal == 0)
		metadataReviewExec(t, db, "INSERT INTO dlsite_metadata_variant(logical_work_id,work_id,provider_id,external_id,edition_language,request_locale,title,tags_json) VALUES (?,?,?,?,?,?,?,'[]')", logical, work, provider, code, language, locale, "Synthetic title "+[]string{"Japanese", "Chinese", "English"}[ordinal])
		metadataReviewExec(t, db, "INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,1)", work)
	}
	metadataReviewExec(t, db, "INSERT INTO app_setting(key,value_json) VALUES ('dlsite_metadata_languages','[\"zh-cn\",\"origin\"]')")
	metadataReviewExec(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','Synthetic Japanese tag'),(1,'zh-cn','合成中文标签')")
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	tag, err := metadatatags.EnsureGenreTx(ctx, tx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := metadatatags.SetNameTx(ctx, tx, tag, "en-us", "Synthetic manual English tag", 0); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := metasync.ProjectDLsiteMetadata(ctx, db, []string{"zh-cn", "origin"}); err != nil {
		t.Fatal(err)
	}
	s := NewServer(db, config.Config{})
	for ordinal, work := range works {
		view, err := s.loadWorkMetadataPresentation(ctx, work)
		if err != nil {
			t.Fatal(err)
		}
		defaultOrdinal := ordinal
		if ordinal == 0 {
			defaultOrdinal = 1
		}
		if view.DefaultVariantKey != testfixture.WorkCode(testfixture.PrefixRJ, defaultOrdinal) {
			t.Fatalf("work %d default=%s", work, view.DefaultVariantKey)
		}
		for _, variant := range view.Variants {
			want := map[string]string{"ja-jp": "Synthetic Japanese tag", "zh-cn": "合成中文标签", "en-us": "Synthetic manual English tag"}[variant.Language]
			if !reflect.DeepEqual(variant.Tags, []string{want}) {
				t.Fatalf("%s variant tags=%v, want %s", variant.Language, variant.Tags, want)
			}
		}
	}
	var title string
	if err := db.QueryRow("SELECT title FROM work WHERE id=?", works[0]).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "Synthetic title Chinese" {
		t.Fatalf("canonical projection title=%q", title)
	}
	tags, err := metadatatags.Read(ctx, db, works[0])
	if err != nil || len(tags) != 1 || tags[0].DisplayName != "合成中文标签" {
		t.Fatalf("default projected tags=%v, %v", tags, err)
	}
}
