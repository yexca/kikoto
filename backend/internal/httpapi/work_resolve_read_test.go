package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestResolveIsReadOnlyForCanonicalAliasEditionAndLegacySnapshot(t *testing.T) {
	db := openMigratedTestDB(t)
	metadataReviewExec(t, db, `INSERT INTO work(id,primary_code,title) VALUES
	 (1,'RJ00000000','Example Work'),(2,'RJ00000001','Example English edition'),
	 (3,'RJ00000002','Example legacy edition'),(4,'RJ00000003','Example legacy origin');
	 INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES(1,1,'RJ00000000');
	 INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,base_code,metadata_language,is_canonical) VALUES
	 (1,1,2,'RJ00000000','','JPN',1),(2,1,2,'RJ00000001','RJ00000000','ENG',0);
	 INSERT INTO work_code_alias(logical_work_id,provider_id,primary_code) VALUES(1,2,'RJ00000004');
	 INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) VALUES
	 (3,2,'example','{"workno":"RJ00000002","base_code":"RJ00000003"}');
	 DELETE FROM work_title_language_dirty`)
	server := NewServer(db, config.Config{})
	metadataReviewExec(t, db, `PRAGMA query_only=ON`)
	for _, item := range []struct {
		code, resolved string
		id             int64
	}{
		{"rj00000000", "RJ00000000", 1}, {"RJ00000004", "RJ00000000", 1},
		{"RJ00000001", "RJ00000000", 1}, {"RJ00000002", "RJ00000003", 4},
	} {
		for range 3 {
			request := httptest.NewRequest(http.MethodGet, "/api/works/"+item.code+"/resolve", nil)
			request.SetPathValue("code", item.code)
			response := httptest.NewRecorder()
			server.resolveWorkCode(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("resolve %s: %d %s", item.code, response.Code, response.Body.String())
			}
			var result workResolveResponse
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.WorkID != item.id || result.ResolvedCode != item.resolved {
				t.Fatalf("resolve %s: %+v", item.code, result)
			}
		}
	}
	var dirty, count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_title_language_dirty`).Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM work`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if dirty != 0 || count != 4 {
		t.Fatalf("resolve changed projections/identity: dirty=%d works=%d", dirty, count)
	}
}

func TestColdRecommendationWaitersLeaveConnectionsForLibraryReads(t *testing.T) {
	db := openMigratedTestDBWithProductionPool(t)
	metadataReviewExec(t, db, `INSERT INTO user_account(id,username,role) VALUES(1,'synthetic-user','user');
	 INSERT INTO work(id,primary_code,title) VALUES(1,'RJ00000000','Example Work')`)
	server := NewServer(db, config.Config{})
	held, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Rollback() }()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	errors := make(chan error, 3)
	for _, session := range []string{"example-a", "example-b", "example-c"} {
		go func() { _, err := server.libraryStore.PrepareRecommendationSession(ctx, 1, session); errors <- err }()
	}
	// Let the three preparations reach the SQLite writer. Only the active
	// preparation may hold a connection while the other two wait outside SQL.
	deadline := time.Now().Add(time.Second)
	for db.Stats().InUse < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	request := httptest.NewRequest(http.MethodGet, "/api/works?sort=recent", nil).WithContext(ctx)
	response := httptest.NewRecorder()
	server.listWorks(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("read blocked behind cold writers: %d %s", response.Code, response.Body.String())
	}
	if err := held.Rollback(); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
}
