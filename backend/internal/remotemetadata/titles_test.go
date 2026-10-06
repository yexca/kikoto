package remotemetadata_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/metadatatitles"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func languageTitleSnapshot(title, translated string) map[string]any {
	return map[string]any{
		"title": title,
		"language_editions": []map[string]any{
			{"workno": testfixture.WorkCode(testfixture.PrefixRJ, 0), "lang": "JPN"},
			{"workno": testfixture.WorkCode(testfixture.PrefixRJ, 1), "lang": "CHI_HANS"},
			{"workno": testfixture.WorkCode(testfixture.PrefixRJ, 2), "lang": "ENG"},
		},
		"other_language_editions_in_db": []map[string]any{
			{"source_id": testfixture.WorkCode(testfixture.PrefixRJ, 1), "lang": "简体中文", "title": translated},
		},
	}
}

// Remote edition titles become language choices of the existing work; an
// untranslated catalog relation must never create a work or a title choice.
func TestRemoteLanguageTitlesStoreOriginalAndSelectViewerLanguage(t *testing.T) {
	db := openRemoteDB(t)
	ctx := context.Background()
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	workID := mustExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,?)", code, code)
	_, provider := addRemoteSource(t, db, "A", 10, "{}")
	// Upgrade-time legacy settings must not change shared title projection,
	// even before startup removes them.
	mustExec(t, db, `INSERT INTO app_setting(key,value_json) VALUES ('dlsite_metadata_languages','["zh-cn","origin"]'),('dlsite_metadata_language','"zh-cn"')`)
	addRemoteSnapshot(t, db, workID, provider, code, languageTitleSnapshot("Example Japanese", "【简体中文版】Example Chinese"))
	reconcile(t, db, workID)
	var title string
	var works, editions int
	if err := db.QueryRow(`SELECT title,(SELECT COUNT(*) FROM work),(SELECT COUNT(*) FROM work_edition) FROM work WHERE id=?`, workID).Scan(&title, &works, &editions); err != nil {
		t.Fatal(err)
	}
	if title != "Example Japanese" || works != 1 || editions != 0 {
		t.Fatalf("remote mapping created identities or lost the original title: %q works=%d editions=%d", title, works, editions)
	}
	inputs, err := metadatatitles.LoadInputs(ctx, db, []int64{workID}, false)
	if err != nil {
		t.Fatal(err)
	}
	input := inputs[workID]
	selected := metadatatitles.Select(input.Variants, input.Manual, []string{"zh-cn"}, input.Fallback)
	if selected.Source != "remote" || selected.SourceName != "Example Remote A" || selected.Language != "zh-cn" || selected.Title != "【简体中文版】Example Chinese" {
		t.Fatalf("language selection lost remote provenance: %+v", selected)
	}
	if _, available := metadatatitles.ForLanguage(input.Variants, input.Manual, "en-us", input.Fallback); available {
		t.Fatal("a relationship without a title became a language choice")
	}
	if got := metadatatitles.Select(input.Variants, input.Manual, []string{"origin"}, input.Fallback); got.Title != "Example Japanese" || got.Language != "ja-jp" {
		t.Fatalf("origin title = %+v", got)
	}
}

// Origin names the declared original edition, even when the requested work is
// a Japanese translation. A missing original title keeps the source's own title.
func TestRemoteSharedTitleUsesDeclaredOriginalEdition(t *testing.T) {
	for _, tc := range []struct {
		name, original, want string
	}{
		{"english_original", "Example English original", "Example English original"},
		{"original_title_missing", "", "Example Japanese translation"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := openRemoteDB(t)
			code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
			original := testfixture.WorkCode(testfixture.PrefixRJ, 0)
			workID := mustExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,?)", code, code)
			_, provider := addRemoteSource(t, db, "A", 10, "{}")
			snapshot := map[string]any{
				"title": "Example Japanese translation", "original_workno": original,
				"language_editions": []map[string]any{
					{"workno": original, "lang": "ENG"},
					{"workno": code, "lang": "JPN"},
				},
			}
			if tc.original != "" {
				snapshot["other_language_editions_in_db"] = []map[string]any{
					{"source_id": original, "lang": "ENG", "title": tc.original},
				}
			}
			addRemoteSnapshot(t, db, workID, provider, code, snapshot)
			reconcile(t, db, workID)
			var title string
			if err := db.QueryRow("SELECT title FROM work WHERE id=?", workID).Scan(&title); err != nil {
				t.Fatal(err)
			}
			if title != tc.want {
				t.Fatalf("shared title=%q, want %q", title, tc.want)
			}
		})
	}
}

// Source reordering and snapshot replacement must update language titles;
// DLsite takeover removes the remote choices without changing manual titles.
func TestRemoteLanguageTitlesFollowSourceOrderRefreshAndDLsiteTakeover(t *testing.T) {
	db := openRemoteDB(t)
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	workID := mustExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,?)", code, code)
	sourceA, providerA := addRemoteSource(t, db, "A", 10, "{}")
	sourceB, providerB := addRemoteSource(t, db, "B", 20, "{}")
	addRemoteSnapshot(t, db, workID, providerB, code, languageTitleSnapshot("Example Original B", "Example Chinese B"))
	addRemoteSnapshot(t, db, workID, providerA, code, languageTitleSnapshot("Example Original A", "Example Chinese A"))
	reconcile(t, db, workID)
	read := func() string {
		t.Helper()
		var title string
		if err := db.QueryRow("SELECT title FROM remote_metadata_title_variant WHERE work_id=? AND language='zh-cn'", workID).Scan(&title); err != nil {
			t.Fatal(err)
		}
		return title
	}
	if got := read(); got != "Example Chinese A" {
		t.Fatalf("source priority title=%q", got)
	}
	setFallback(t, db, false, sourceB, sourceA)
	reconcile(t, db, workID)
	if got := read(); got != "Example Chinese B" {
		t.Fatalf("configured order title=%q", got)
	}
	addRemoteSnapshot(t, db, workID, providerB, code, map[string]any{"title": "Example Original B revised"})
	reconcile(t, db, workID)
	if got := read(); got != "Example Chinese A" {
		t.Fatalf("latest snapshot did not remove the old translation: %q", got)
	}
	var provider int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code='dlsite'").Scan(&provider); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) VALUES (?,?,?,'{}')", workID, provider, code)
	reconcile(t, db, workID)
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM remote_metadata_title_variant WHERE work_id=?", workID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("remote choices survived DLsite takeover: count=%d err=%v", count, err)
	}
}

// Untrusted edition collections remain bounded and never infer a title's
// language from a request locale, display text or a source-local id.
func TestRemoteLanguageTitleInputBoundsAndIdentity(t *testing.T) {
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	for _, tc := range []struct {
		name    string
		work    map[string]any
		invalid bool
	}{
		{"too_many_editions", map[string]any{"language_editions": make([]map[string]any, 33)}, true},
		{"too_many_titles", map[string]any{"other_language_editions_in_db": make([]map[string]any, 33)}, true},
		{"oversized_title", map[string]any{"other_language_editions_in_db": []map[string]any{{"title": strings.Repeat("x", 2049)}}}, true},
		{"source_local_id", map[string]any{"other_language_editions_in_db": []map[string]any{{"id": 1, "lang": "CHI_HANS", "title": "Example Chinese"}}}, false},
		{"unknown_language", map[string]any{"language_editions": []map[string]any{{"workno": code, "lang": "unknown"}}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.work["source_id"], tc.work["title"] = code, "Example Original"
			raw, _ := json.Marshal(tc.work)
			work, err := remotemetadata.Decode(raw)
			if tc.invalid {
				if err == nil {
					t.Fatal("accepted an over-limit edition collection")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(work.TitleVariants) != 1 || work.TitleVariants[0].Language != "" {
				t.Fatalf("inferred an undeclared title language: %+v", work.TitleVariants)
			}
		})
	}
}
