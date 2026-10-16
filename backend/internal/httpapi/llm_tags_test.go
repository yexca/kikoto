package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

func TestLLMTagCandidatesReuseWithoutChangingIdentityBeforeConfirmation(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	ctx := context.Background()
	_, _ = f.db.Exec("UPDATE work SET age_rating='r15' WHERE id=?", f.workID)
	_, _ = f.db.Exec("INSERT INTO work(primary_code,title,age_rating) VALUES('RJ00000001','Example Work 1','general')")
	var second int64
	_ = f.db.QueryRow("SELECT id FROM work WHERE primary_code='RJ00000001'").Scan(&second)
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	tagID, err := metadatatags.EnsureLegacyTx(ctx, tx, "Example tag")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{f.workID, second} {
		if _, err := tx.ExecContext(ctx, "INSERT INTO work_tag(work_id,tag_id,source) VALUES(?,?,'manual')", id, tagID); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	// Tag identities do not classify selected tag-name text. Reused candidates
	// and final acceptance must keep the same complete source assessment.
	if err := f.server.llmStore.SavePolicy(ctx, llm.Policy{LLMTranslationTextOnly: true, TagRules: []llm.TagRule{{TagID: tagID, Action: "blocked"}}}); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"tags\":[\"Example translated tag\" ]}"}}]}`))
	}))
	defer upstream.Close()
	p := llmTestProvider(t, f, upstream.URL, "external", "safe")
	payload, _ := json.Marshal(llmTranslatePayload{ProviderID: p.ID, Target: "en-us", Fields: []string{"tags"}})
	precheck := httptest.NewRecorder()
	f.server.precheckLLMWork(precheck, llmTestRequest(f, "POST", string(payload)))
	var checked struct {
		Assessment llm.Assessment `json:"assessment"`
		Fields     []string       `json:"checkedFields"`
	}
	if err := json.Unmarshal(precheck.Body.Bytes(), &checked); err != nil || precheck.Code != 200 || checked.Assessment.Class != "safe" || len(checked.Fields) != 1 || checked.Fields[0] != "tags" || requests.Load() != 0 {
		t.Fatalf("tag text precheck: %d %s %v", precheck.Code, precheck.Body.String(), err)
	}
	translate := func(workID int64) string {
		clone := f
		clone.workID = workID
		w := httptest.NewRecorder()
		f.server.translateWorkWithLLM(w, llmTestRequest(clone, "POST", string(payload)))
		if w.Code != 200 {
			t.Fatalf("translate: %d %s", w.Code, w.Body.String())
		}
		var body struct {
			ID string `json:"previewId"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.ID
	}
	firstPreview := translate(f.workID)
	_ = translate(second)
	if requests.Load() != 1 {
		t.Fatalf("duplicate tag requests=%d", requests.Load())
	}
	var accepted int
	_ = f.db.QueryRow("SELECT COUNT(*) FROM metadata_tag_llm_name").Scan(&accepted)
	if accepted != 0 {
		t.Fatal("candidate changed shared names before confirmation")
	}
	w := httptest.NewRecorder()
	f.server.applyLLMTranslation(w, llmTestRequest(f, "PUT", `{"previewId":"`+firstPreview+`"}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	names, err := metadatatags.LocalizedNames(ctx, f.db, []int64{tagID}, []string{"en-us"})
	if err != nil || names[tagID] != "Example translated tag" {
		t.Fatalf("names=%v err=%v", names, err)
	}
	var tags, links int
	_ = f.db.QueryRow("SELECT COUNT(*) FROM tag WHERE namespace='metadata'").Scan(&tags)
	_ = f.db.QueryRow("SELECT COUNT(*) FROM work_tag WHERE tag_id=?", tagID).Scan(&links)
	if tags != 1 || links != 2 {
		t.Fatalf("translation changed identity or membership: tags=%d links=%d", tags, links)
	}
	if _, err := f.db.Exec("INSERT INTO metadata_tag_provider_name(tag_id,language,name,provider_id) VALUES(?,'en-us','Example official tag',?)", tagID, f.providerID); err != nil {
		t.Fatal(err)
	}
	names, err = metadatatags.LocalizedNames(ctx, f.db, []int64{tagID}, []string{"en-us"})
	if err != nil || names[tagID] != "Example official tag" {
		t.Fatal("provider name did not take priority")
	}
	tx, err = f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := metadatatags.SetNameTx(ctx, tx, tagID, "en-us", "Example manual tag", f.userID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	names, err = metadatatags.LocalizedNames(ctx, f.db, []int64{tagID}, []string{"en-us"})
	if err != nil || names[tagID] != "Example manual tag" {
		t.Fatal("manual name did not take priority")
	}
}
