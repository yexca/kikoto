package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// One remote fallback response supplies the stored language choices. Viewer
// preferences and manual edits change presentation without requesting sibling
// works or claiming that remote metadata is a successful DLsite sync.
func TestRemoteFallbackLanguageTitlesReachDetailAndPersonalPreferences(t *testing.T) {
	f := newRemoteFallbackFixture(t, 40, dlsite.ErrNoProduct)
	translated := testfixture.WorkCode(testfixture.PrefixRJ, 41)
	var hits atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/api/workInfo/"+f.code {
			t.Errorf("unexpected sibling or catalog request: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"source_id": f.code, "title": "Example Japanese",
			"language_editions":             []map[string]any{{"workno": f.code, "lang": "JPN"}, {"workno": translated, "lang": "CHI_HANS"}},
			"other_language_editions_in_db": []map[string]any{{"source_id": translated, "lang": "简体中文", "title": "Example Chinese"}},
		})
	}))
	defer remote.Close()
	f.enable(t, f.addSource(t, "A", 10, remote.URL))
	if _, err := f.runJob(t); err != nil {
		t.Fatal(err)
	}
	userID, viewer := metadataLanguageUser(t, f.db, "synthetic-language-remote")
	if response := patchMetadataLanguages(t, f.server, userID, `{"metadataLanguages":["zh-cn"]}`); response.Code != http.StatusOK {
		t.Fatalf("personal priority status=%d", response.Code)
	}
	for _, tc := range []struct {
		ctx        context.Context
		title, key string
	}{{context.Background(), "Example Japanese", f.code}, {viewer, "Example Chinese", translated}} {
		detail, err := f.server.loadWorkDetail(tc.ctx, userID, f.workID, false)
		if err != nil {
			t.Fatal(err)
		}
		if detail.Title != tc.title || detail.MetadataView.DefaultVariantKey != tc.key || len(detail.MetadataView.Variants) != 2 {
			t.Fatalf("detail lost language choices: title=%q view=%+v", detail.Title, detail.MetadataView)
		}
		if detail.MetadataSync.Status != workMetadataSyncStatusRemoteFallback {
			t.Fatalf("remote language title fabricated DLsite success: %+v", detail.MetadataSync)
		}
		if detail.TitleChoices["zh-cn"].SourceName != "Example Remote A" {
			t.Fatalf("title editor lost source attribution: %+v", detail.TitleChoices["zh-cn"])
		}
	}
	if _, err := f.db.Exec(`INSERT INTO work_manual_override(work_id,field_name,language,value_json) VALUES (?,'title','zh-cn','"Example manual Chinese"')`, f.workID); err != nil {
		t.Fatal(err)
	}
	detail, err := f.server.loadWorkDetail(viewer, userID, f.workID, false)
	if err != nil || detail.Title != "Example manual Chinese" {
		t.Fatalf("manual title failed to override remote edition: %q %v", detail.Title, err)
	}
	var stored string
	if err := f.db.QueryRow("SELECT title FROM work WHERE id=?", f.workID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "Example Japanese" || hits.Load() != 1 {
		t.Fatalf("presentation rewrote shared state or requested editions: title=%q requests=%d", stored, hits.Load())
	}
}
