package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestMetadataCirclesAreOrganizedByMakerCodeWithLatestCover(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	// Names run opposite to codes, so a name order would reverse the list. A
	// longer maker id is a later one; the remote-only circle has no code.
	circles := []struct{ name, code string }{
		{"Example Circle 1", "RG000000002"},
		{"Example Circle 2", "RG00000010"},
		{"Example Circle 3", "RG00000002"},
		{"Example Circle 0", ""},
	}
	ids := map[string]int64{}
	for ordinal, circle := range circles {
		work := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Example Work')", testfixture.WorkCode(testfixture.PrefixRJ, ordinal))
		party := metadataReviewExec(t, db, "INSERT INTO party(party_type,display_name,provider_name) VALUES ('circle',?,?)", circle.name, circle.name)
		metadataReviewExec(t, db, "INSERT INTO work_party(work_id,party_id,role,source) VALUES (?,?,'circle','dlsite')", work, party)
		if circle.code != "" {
			metadataReviewExec(t, db, "INSERT INTO party_external_id(party_id,provider_id,id_type,external_id,is_primary) SELECT ?,id,'maker_id',?,1 FROM metadata_provider WHERE code='dlsite'", party, circle.code)
		}
		ids[circle.name] = party
	}
	coverCode := testfixture.WorkCode(testfixture.PrefixRJ, 2)
	coverPath := filepath.Join(s.cfg.CacheRoot, "cover", filepath.FromSlash(coverAssetRelativePath(coverCode, ".jpg")))
	if err := os.MkdirAll(filepath.Dir(coverPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(coverPath, []byte("synthetic"), 0o600); err != nil {
		t.Fatal(err)
	}

	response := metadataReviewRequest(t, s, http.MethodGet, "/api/metadata/circles", "", account.User{ID: 1, Permissions: []string{"library:write"}})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var page struct {
		Circles []metadataCircleEntry
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	var codes []string
	for _, circle := range page.Circles {
		codes = append(codes, circle.Code)
	}
	if want := []string{"RG00000002", "RG00000010", "RG000000002", ""}; !reflect.DeepEqual(codes, want) {
		t.Fatalf("codes = %q, want %q", codes, want)
	}
	if page.Circles[0].ID != ids["Example Circle 3"] || page.Circles[0].CoverURL == "" {
		t.Fatalf("first circle = %+v, want Example Circle 3 with its work cover", page.Circles[0])
	}
	if page.Circles[1].CoverURL != "" {
		t.Fatalf("circle without a cached cover got %q", page.Circles[1].CoverURL)
	}
}

func TestVoicesSortByPersonIDOnlyWhenRequested(t *testing.T) {
	db := openMigratedTestDB(t)
	for ordinal := 0; ordinal < 2; ordinal++ {
		metadataReviewExec(t, db, "INSERT INTO work(id,primary_code,title) VALUES (?,?,'Example Work')", ordinal+1, testfixture.WorkCode(testfixture.PrefixRJ, ordinal))
	}
	metadataReviewExec(t, db, "INSERT INTO person(id,display_name) VALUES (1,'Example Voice 1'),(2,'Example Voice 2')")
	// Person 2 has more credits, so browsing lists it first.
	metadataReviewExec(t, db, "INSERT INTO work_credit(work_id,person_id,role,source) VALUES (1,1,'voice_actor','test'),(1,2,'voice_actor','test'),(2,2,'voice_actor','test')")
	s := NewServer(db, config.Config{})
	order := func(path string) []int64 {
		response := httptest.NewRecorder()
		s.listVoices(response, httptest.NewRequest(http.MethodGet, path, nil))
		var page voiceSummaryPage
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		ids := []int64{}
		for _, voice := range page.Voices {
			ids = append(ids, voice.PersonID)
		}
		return ids
	}
	if got := order("/api/voices"); !reflect.DeepEqual(got, []int64{2, 1}) {
		t.Fatalf("browse order = %v", got)
	}
	if got := order("/api/voices?sort=id"); !reflect.DeepEqual(got, []int64{1, 2}) {
		t.Fatalf("id order = %v", got)
	}
}
