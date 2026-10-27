package library

import (
	"context"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/metadatatitles"
)

func TestLLMTitlesParticipateInDisplaySortingSearchAndExpiry(t *testing.T) {
	db := openSearchTestDB(t)
	first := insertSearchWork(t, db, 0, "Zulu original")
	insertSearchWork(t, db, 1, "Bravo original")
	execSearchFixture(t, db, `INSERT INTO work_llm_translation(work_id,language,field_name,value_text,source_hash,source_text,source_work_id) VALUES(?,'en-us','title','Alpha machine','synthetic-hash','Zulu original',?)`, first, first)
	store := NewStore(db)
	ctx := context.Background()
	if err := store.RefreshTitleLanguages(ctx); err != nil {
		t.Fatal(err)
	}
	if got := titleSortCodes(t, store, []string{"en-us"}, 0, 1); !reflect.DeepEqual(got, []string{"RJ00000000", "RJ00000001"}) {
		t.Fatal(got)
	}
	if err := store.RefreshSearchIndex(ctx); err != nil {
		t.Fatal(err)
	}
	page, err := store.ListPage(ctx, ListOptions{PageSize: 20, Query: "machine"})
	if err != nil || len(page.Works) != 1 {
		t.Fatalf("search=%+v err=%v", page, err)
	}
	inputs, err := metadatatitles.LoadInputs(ctx, db, []int64{first}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := metadatatitles.Select(inputs[first].Variants, inputs[first].Manual, []string{"en-us"}, inputs[first].Fallback); got.Source != "llm" || got.Title != "Alpha machine" {
		t.Fatal(got)
	}
	execSearchFixture(t, db, `INSERT INTO work_manual_override(work_id,field_name,language,value_json) VALUES(?,'title','en-us','"Charlie manual"')`, first)
	if err := store.RefreshTitleLanguages(ctx); err != nil {
		t.Fatal(err)
	}
	if got := titleSortCodes(t, store, []string{"en-us"}, 0, 1); !reflect.DeepEqual(got, []string{"RJ00000001", "RJ00000000"}) {
		t.Fatal(got)
	}
	execSearchFixture(t, db, "UPDATE work SET title='Changed original' WHERE id=?", first)
	var status string
	_ = db.QueryRow("SELECT status FROM work_llm_translation WHERE work_id=?", first).Scan(&status)
	if status != "superseded" {
		t.Fatalf("source edit status=%s", status)
	}
	if err := store.RefreshSearchIndex(ctx); err != nil {
		t.Fatal(err)
	}
	page, err = store.ListPage(ctx, ListOptions{PageSize: 20, Query: "machine"})
	if err != nil || len(page.Works) != 0 {
		t.Fatalf("expired search=%+v err=%v", page, err)
	}
}
