package httpapi

import (
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Opt-in, with no latency assertions. A synthetic library of families, shared
// tags, local tracks, display names, lyrics and translation history measures
// one Translation page per filter, as the Metadata view requests it.
func TestTranslationCoveragePerformance(t *testing.T) {
	if os.Getenv("KIKOTO_BROWSE_PERF") != "1" {
		t.Skip("opt-in performance experiment")
	}
	works := 10000
	if value, err := strconv.Atoi(os.Getenv("KIKOTO_TRANSLATION_PERF_WORKS")); err == nil && value >= 1000 && value <= 100000 {
		works = value
	}
	db := openMigratedTestDBWithProductionPool(t)
	seedTranslationCoverageScale(t, db, works)
	if err := storage.OptimizeStatistics(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	s := NewServer(db, config.Config{})
	lastPage := works / 4 / 50
	for _, filter := range []string{"any", "all", "title", "description", "tags", "files", "lyrics", "complete"} {
		for _, page := range []int{1, lastPage} {
			path := fmt.Sprintf("/api/metadata/translation-coverage?language=zh-cn&missing=%s&page=%d&pageSize=50", filter, page)
			times := make([]time.Duration, 0, 5)
			for range 5 {
				start := time.Now()
				response := metadataRequest(s.listTranslationCoverage, http.MethodGet, path, "", "metadata:sync")
				times = append(times, time.Since(start))
				if response.Code != http.StatusOK {
					t.Fatalf("%s: %d %s", path, response.Code, response.Body)
				}
			}
			logBrowseTiming(t, fmt.Sprintf("translation/works=%d/missing=%s/page=%d", works, filter, page), times, 1, 0)
		}
	}
}

// seedTranslationCoverageScale builds `works` works in which each eighth work
// and the next form one family of a Japanese original and a Simplified Chinese
// edition. Each work has five of 300 shared tags (half named in Simplified
// Chinese) and ten local tracks with two lyrics files; a tenth of the works
// have display names, a fifth have lyrics in the language, and one user has a
// translation history twice the size of the library with one task in 50 still
// queued.
func seedTranslationCoverageScale(t *testing.T, db *sql.DB, works int) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	workStmt, err := tx.Prepare("INSERT INTO work (id,primary_code,title) VALUES (?,?,?)")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workStmt.Close() }()
	for index := range works {
		if _, err := workStmt.Exec(index+1, testfixture.HighCardinalityWorkCodeAt(index), fmt.Sprintf("Example Work %d", index)); err != nil {
			t.Fatal(err)
		}
	}
	const series = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?) "
	exec("INSERT INTO user_account (id,username,role) VALUES (1,'synthetic-user','admin')")
	exec("INSERT INTO file_source (id,code,display_name,source_type) VALUES (1,'example_local','Example Local','local_folder')")
	exec(`INSERT INTO logical_work (id,canonical_work_id,canonical_code)
		SELECT id, id, primary_code FROM work WHERE id % 8 = 1`)
	exec(`INSERT INTO work_edition (work_id,logical_work_id,primary_code,metadata_language,is_canonical)
		SELECT work.id, logical.id, work.primary_code, CASE WHEN work.id = logical.id THEN 'JPN' ELSE 'CHI_HANS' END, work.id = logical.id
		FROM work INNER JOIN logical_work AS logical ON work.id IN (logical.id, logical.id + 1)`)
	exec(series+"INSERT INTO tag (id,namespace,normalized_name,display_name) SELECT i,'metadata','example-tag-'||i,'Example Tag '||i FROM n", 300)
	exec("INSERT INTO metadata_tag (tag_id) SELECT id FROM tag")
	exec("INSERT INTO metadata_tag_name (tag_id,language,name) SELECT id,'zh-cn','Example Name '||id FROM tag WHERE id % 2 = 0")
	exec(series+"INSERT INTO work_tag (work_id,tag_id,source) SELECT work.id, 1 + (work.id * 7 + n.i * 61) % 300, 'test' FROM work, n", 5)
	exec(series+`INSERT INTO media_item (id,work_id,kind,title)
		SELECT (work.id - 1) * 12 + n.i, work.id, CASE WHEN n.i <= 10 THEN 'audio' ELSE 'text' END, 'Track '||n.i FROM work, n`, 12)
	exec(`INSERT INTO media_file_location (media_item_id,file_source_id,location_type,path,availability)
		SELECT id, 1, 'local', 'Library/'||work_id||'/'||id, 'available' FROM media_item`)
	exec(`INSERT INTO media_item_display_name (media_item_id,language,name)
		SELECT id, 'zh-cn', 'Example Display '||id FROM media_item WHERE work_id % 10 = 0`)
	exec(`INSERT INTO media_lyrics_assignment (audio_media_item_id,language,lyrics_media_item_id)
		SELECT item.id, 'zh-cn', (item.work_id - 1) * 12 + 11 FROM media_item AS item
		WHERE item.kind = 'audio' AND item.work_id % 5 = 0`)
	exec("INSERT INTO workflow_run (id,workflow_code,display_name,status,trigger_type) VALUES (1,'llm_translation','Example Translation','completed','manual')")
	exec(series+`INSERT INTO llm_translation_task (workflow_run_id,user_id,work_id,dedup_key,input_hash,policy_hash,config_hash,request_json,state)
		SELECT 1, 1, 1 + (n.i * 37) % ?, 'synthetic-'||n.i, 'hash', 'hash', 'hash', '{"targetLanguage":"zh-cn"}',
			CASE WHEN n.i % 50 = 0 THEN 'pending' ELSE 'ready' END FROM n`, works*2, works)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
