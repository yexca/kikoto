package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

type demoRecommendationTestCard struct {
	ID             int64  `json:"id"`
	PrimaryCode    string `json:"primaryCode"`
	RecommendScore int    `json:"recommendScore"`
}

type demoRecommendationTestPage struct {
	Works                     []demoRecommendationTestCard `json:"works"`
	Total                     int                          `json:"total"`
	RecommendationContext     string                       `json:"recommendationContext"`
	RecommendationUnavailable bool                         `json:"recommendationUnavailable"`
}

func newDemoRecommendationFixture(t *testing.T) (*sql.DB, *Server, int64) {
	t.Helper()
	db, server := newDemoRemoteFixture(t, 12)
	metadataReviewExec(t, db, `INSERT INTO file_source(code,display_name,source_type,enabled)
		VALUES (?,?, 'kikoeru_compatible',1)`, demoRemoteSourceCode, demoRemoteSourceDisplayName)
	var sourceID int64
	if err := db.QueryRow("SELECT id FROM file_source WHERE code = ?", demoRemoteSourceCode).Scan(&sourceID); err != nil {
		t.Fatal(err)
	}
	metadataReviewExec(t, db, `INSERT INTO file_source_endpoint(file_source_id,api_url,base_url) VALUES (?,?,?)`, sourceID, demoRemoteSourceURL, demoRemoteSourceURL)
	// Deliberately include restricted records in the persisted simulated source:
	// admission must precede pagination, rather than just dropping page cards.
	metadataReviewExec(t, db, `INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability)
		SELECT id,?,?,'available' FROM work`, sourceID, sourcePresenceTypeRemoteSource)
	metadataReviewExec(t, db, `INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id) SELECT id FROM work`)
	for index := range 14 {
		title := fmt.Sprintf("Example Other %d", index)
		if index < 6 || index >= 12 {
			title = fmt.Sprintf("Example Match %d", index)
		}
		metadataReviewExec(t, db, "UPDATE work SET title=? WHERE primary_code=?", title, testfixture.WorkCode(testfixture.PrefixRJ, index))
	}
	if err := server.libraryStore.RefreshSearchIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	return db, server, sourceID
}

func demoRecommendationRequest(t *testing.T, handler http.Handler, method, target string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	body := ""
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = string(raw)
	}
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeDemoRecommendationResponse(t *testing.T, response *httptest.ResponseRecorder, result any) {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("Demo recommendation status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), result); err != nil {
		t.Fatal(err)
	}
}

func assertDemoRecommendationStorageUntouched(t *testing.T, db *sql.DB, server *Server) {
	t.Helper()
	for _, table := range []string{"recommendation_generation", "recommendation_generation_profile", "recommendation_generation_state", "recommendation_client_session", "recommendation_snapshot", "recommendation_query_context", "recommendation_query_candidate", "recommendation_query_checkpoint", "recommendation_catalog_epoch", "recommendation_catalog_work", "recommendation_catalog_entity", "recommendation_catalog_frequency", "recommendation_catalog_name"} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("Demo simulation persisted %d rows in %s", count, table)
		}
	}
	var epoch sql.NullInt64
	if err := db.QueryRow("SELECT published_epoch FROM recommendation_catalog_state WHERE id=1").Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	if epoch.Valid {
		t.Fatalf("Demo simulation published real catalog epoch %d", epoch.Int64)
	}
	for key, value := range server.libraryStore.RecommendationDiagnostics() {
		if value != 0 {
			t.Fatalf("Demo simulation used real recommendation engine: %s=%d", key, value)
		}
	}
}

func TestDemoRecommendationScoresAgreeAcrossReadSurfacesWithoutReadyCatalog(t *testing.T) {
	db, server, sourceID := newDemoRecommendationFixture(t)
	handler := server.Routes()
	session := "synthetic-demo-session"
	var listed demoRecommendationTestPage
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		"/api/works?scope=local&sort=recommend&pageSize=100&seed=17&recommendationSession="+session, nil), &listed)
	if listed.Total != 12 || len(listed.Works) != 12 || listed.RecommendationUnavailable || listed.RecommendationContext != "" {
		t.Fatalf("Demo recommend page = %+v", listed)
	}
	scores := map[string]int{}
	distinctScores := map[int]bool{}
	for _, work := range listed.Works {
		if work.RecommendScore < 0 || work.RecommendScore > 100 {
			t.Fatalf("Demo score outside 0..100: %+v", work)
		}
		scores[work.PrimaryCode] = work.RecommendScore
		distinctScores[work.RecommendScore] = true
	}
	if len(distinctScores) < 2 {
		t.Fatalf("Demo uses one constant score for every work: %v", scores)
	}
	var ordinary demoRecommendationTestPage
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		"/api/works?scope=local&sort=recent&pageSize=100&recommendBadges=true&recommendationSession="+session, nil), &ordinary)
	if ordinary.Total != 12 || len(ordinary.Works) != 12 || ordinary.RecommendationUnavailable {
		t.Fatalf("Demo ordinary badge page = %+v", ordinary)
	}
	for _, work := range ordinary.Works {
		if work.RecommendScore != scores[work.PrimaryCode] {
			t.Fatalf("ordinary badge differs: %+v, want%d", work, scores[work.PrimaryCode])
		}
	}
	var remote demoRecommendationTestPage
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		fmt.Sprintf("/api/remote-sources/%d/works?pageSize=100&recommendBadges=true&recommendationSession=%s", sourceID, session), nil), &remote)
	if remote.Total != 12 || len(remote.Works) != 12 || remote.RecommendationUnavailable {
		t.Fatalf("Demo remote page = %+v", remote)
	}
	for _, work := range remote.Works {
		if work.RecommendScore != scores[work.PrimaryCode] {
			t.Fatalf("remote badge differs: %+v, want%d", work, scores[work.PrimaryCode])
		}
	}
	work := listed.Works[0]
	var detail demoRecommendationTestCard
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		fmt.Sprintf("/api/works/%d?includeMedia=false&recommendationSession=%s", work.ID, session), nil), &detail)
	if detail.RecommendScore != work.RecommendScore {
		t.Fatalf("detail score=%d, list=%d", detail.RecommendScore, work.RecommendScore)
	}
	var breakdown struct {
		AlgorithmVersion string            `json:"algorithmVersion"`
		ScoreKind        string            `json:"scoreKind"`
		Score            int               `json:"score"`
		RawScore         int               `json:"rawScore"`
		Components       []json.RawMessage `json:"components"`
	}
	explanation := demoRecommendationRequest(t, handler, http.MethodGet,
		fmt.Sprintf("/api/works/%d/recommendation?recommendationSession=%s", work.ID, session), nil)
	decodeDemoRecommendationResponse(t, explanation, &breakdown)
	if breakdown.Score != work.RecommendScore || breakdown.RawScore != work.RecommendScore || breakdown.AlgorithmVersion != "demo-random-v1" || breakdown.ScoreKind != "demo_random" || breakdown.Components == nil || len(breakdown.Components) != 0 {
		t.Fatalf("Demo explanation claims real affinity or disagrees: %+v", breakdown)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(explanation.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"lane", "signals", "ordering"} {
		if _, exists := fields[field]; exists {
			t.Fatalf("Demo explanation includes real recommendation field %s", field)
		}
	}
	candidate := library.RecommendationCandidate{PrimaryCode: work.PrimaryCode, WorkID: &work.ID, Tags: []string{"Example Tag"}, VoiceActors: []string{"Example Voice"}, Circle: "Example Circle"}
	var post struct {
		Scores []remoteRecommendationScore `json:"scores"`
	}
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodPost,
		fmt.Sprintf("/api/remote-sources/%d/recommendations", sourceID), remoteRecommendationRequest{SessionID: session, Works: []library.RecommendationCandidate{candidate}}), &post)
	if len(post.Scores) != 1 || post.Scores[0].PrimaryCode != work.PrimaryCode || post.Scores[0].Score != work.RecommendScore {
		t.Fatalf("Demo POST scores=%+v", post.Scores)
	}
	// Real taste/state changes cannot influence a presentation-only score.
	metadataReviewExec(t, db, `INSERT INTO user_work_state(user_id,work_id,listening_status,favorite)
		SELECT id,?,'relisten',1 FROM user_account WHERE username=?`, work.ID, account.DemoUsername)
	tagID := metadataReviewExec(t, db, `INSERT INTO tag(namespace,normalized_name,display_name) VALUES ('metadata','example-tag','Example Tag')`)
	metadataReviewExec(t, db, "INSERT INTO work_tag(work_id,tag_id,source) VALUES (?,?,'test')", work.ID, tagID)
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodPost,
		fmt.Sprintf("/api/remote-sources/%d/recommendations", sourceID), remoteRecommendationRequest{SessionID: session, Works: []library.RecommendationCandidate{candidate}}), &post)
	if post.Scores[0].Score != work.RecommendScore {
		t.Fatalf("Demo score used real feedback: %d versus%d", post.Scores[0].Score, work.RecommendScore)
	}
	var refreshed demoRecommendationTestPage
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		"/api/works?scope=local&sort=recommend&pageSize=100&seed=17&recommendationSession=synthetic-demo-refresh", nil), &refreshed)
	changed := false
	for _, candidate := range refreshed.Works {
		changed = changed || candidate.RecommendScore != scores[candidate.PrimaryCode]
	}
	if !changed {
		t.Fatal("new Demo session does not refresh simulated scores")
	}
	var dirty int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty").Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if dirty == 0 {
		t.Fatal("fixture must retain pending metadata projection")
	}
	assertDemoRecommendationStorageUntouched(t, db, server)
}

func TestDemoRecommendationReadOnlyPostValidatesAdmissionAndDefaultSession(t *testing.T) {
	db, server, sourceID := newDemoRecommendationFixture(t)
	handler := server.Routes()
	var page demoRecommendationTestPage
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		"/api/works?scope=local&sort=recent&recommendBadges=true&pageSize=100", nil), &page)
	if len(page.Works) != 12 {
		t.Fatalf("default Demo score page has%d cards", len(page.Works))
	}
	work := page.Works[0]
	postURL := fmt.Sprintf("/api/remote-sources/%d/recommendations", sourceID)
	valid := remoteRecommendationRequest{Works: []library.RecommendationCandidate{{PrimaryCode: work.PrimaryCode, WorkID: &work.ID}}}
	var scores struct {
		Scores []remoteRecommendationScore `json:"scores"`
	}
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodPost, postURL, valid), &scores)
	if len(scores.Scores) != 1 || scores.Scores[0].Score != work.RecommendScore {
		t.Fatalf("missing session changes default Demo score: %+v", scores.Scores)
	}
	valid.Works[0].PrimaryCode = strings.ToLower(work.PrimaryCode)
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodPost, postURL, valid), &scores)
	if scores.Scores[0].Score != work.RecommendScore {
		t.Fatalf("case variation changes work identity score: %+v", scores.Scores)
	}
	for _, index := range []int{12, 13, 99} {
		candidate := library.RecommendationCandidate{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, index)}
		response := demoRecommendationRequest(t, handler, http.MethodPost, postURL, remoteRecommendationRequest{Works: []library.RecommendationCandidate{candidate}})
		if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), `"code":"not_found"`) {
			t.Fatalf("non-admitted Demo candidate status%d body%s", response.Code, response.Body.String())
		}
	}
	mismatch := remoteRecommendationRequest{Works: []library.RecommendationCandidate{{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 99), WorkID: &work.ID}}}
	if response := demoRecommendationRequest(t, handler, http.MethodPost, postURL, mismatch); response.Code != http.StatusNotFound {
		t.Fatalf("mismatched Demo identity status%d body%s", response.Code, response.Body.String())
	}
	for _, target := range []string{"/api/auth/login", "/api/recommendation-events", "/api/remote-sources/0/recommendations", "/api/remote-sources/not-a-source/recommendations"} {
		response := demoRecommendationRequest(t, handler, http.MethodPost, target, valid)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"demo_read_only"`) {
			t.Fatalf("Demo POST exemption broadens to%s: status%d body%s", target, response.Code, response.Body.String())
		}
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM work").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 14 {
		t.Fatalf("Demo scoring materializes work: %d rows", count)
	}
	assertDemoRecommendationStorageUntouched(t, db, server)
}

func TestDemoRecommendationSeededPagingPreservesAdmissionAndAccurateFilters(t *testing.T) {
	db, server, sourceID := newDemoRecommendationFixture(t)
	handler := server.Routes()
	sessionScores := map[string]int{}
	collect := func(target string, seed int, expected int) []string {
		t.Helper()
		codes := []string{}
		seen := map[string]bool{}
		for page := 1; page <= (expected+3)/4+1; page++ {
			var result demoRecommendationTestPage
			decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
				target+"&recommendationSession=synthetic-pagination&seed="+strconv.Itoa(seed)+"&pageSize=4&page="+strconv.Itoa(page), nil), &result)
			if result.Total != expected || len(result.Works) > 4 || result.RecommendationUnavailable {
				t.Fatalf("page%d got total%d rows%d unavailable%v", page, result.Total, len(result.Works), result.RecommendationUnavailable)
			}
			for _, work := range result.Works {
				if score, exists := sessionScores[work.PrimaryCode]; exists && score != work.RecommendScore {
					t.Fatalf("page or seed changes same-session score for %s: %d versus %d", work.PrimaryCode, work.RecommendScore, score)
				}
				sessionScores[work.PrimaryCode] = work.RecommendScore
				if seen[work.PrimaryCode] {
					t.Fatalf("duplicate across Demo pages: %s", work.PrimaryCode)
				}
				seen[work.PrimaryCode] = true
				codes = append(codes, work.PrimaryCode)
			}
		}
		if len(codes) != expected {
			t.Fatalf("Demo pages contain%d works, want%d", len(codes), expected)
		}
		return codes
	}
	for _, target := range []string{"/api/works?scope=local&sort=recommend", fmt.Sprintf("/api/remote-sources/%d/works?sort=random&recommendBadges=true", sourceID)} {
		first := collect(target, 17, 12)
		var whole demoRecommendationTestPage
		decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
			target+"&recommendationSession=synthetic-pagination&seed=17&pageSize=100&page=1", nil), &whole)
		wholeCodes := make([]string, 0, len(whole.Works))
		for _, work := range whole.Works {
			wholeCodes = append(wholeCodes, work.PrimaryCode)
			if score := sessionScores[work.PrimaryCode]; score != work.RecommendScore {
				t.Fatalf("page size changes same-session score for %s", work.PrimaryCode)
			}
		}
		if whole.Total != 12 || !reflect.DeepEqual(first, wholeCodes) {
			t.Fatalf("Demo pageSize=4 concatenation differs from pageSize=100: %v / %v", first, wholeCodes)
		}
		if repeated := collect(target, 17, 12); !reflect.DeepEqual(first, repeated) {
			t.Fatalf("same Demo seed changes order: %v /%v", first, repeated)
		}
		if changed := collect(target, 41, 12); reflect.DeepEqual(first, changed) {
			t.Fatalf("different Demo seeds do not explore: %v", first)
		}
		filtered := collect(target+"&q="+url.QueryEscape("Match"), 17, 6)
		for _, code := range filtered {
			if code >= testfixture.WorkCode(testfixture.PrefixRJ, 6) {
				t.Fatalf("filtered Demo result admits unrelated/restricted work%s", code)
			}
		}
	}
	for _, index := range []int{12, 13} {
		var workID int64
		if err := db.QueryRow("SELECT id FROM work WHERE primary_code=?", testfixture.WorkCode(testfixture.PrefixRJ, index)).Scan(&workID); err != nil {
			t.Fatal(err)
		}
		for _, suffix := range []string{"?includeMedia=false", "/recommendation?recommendationSession=synthetic-pagination"} {
			response := demoRecommendationRequest(t, handler, http.MethodGet, fmt.Sprintf("/api/works/%d%s", workID, suffix), nil)
			if response.Code != http.StatusNotFound {
				t.Fatalf("restricted Demo detail status%d body%s", response.Code, response.Body.String())
			}
		}
	}
	var trackedID int64
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code=?", testfixture.WorkCode(testfixture.PrefixRJ, 11)).Scan(&trackedID); err != nil {
		t.Fatal(err)
	}
	metadataReviewExec(t, db, "DELETE FROM work_source_presence WHERE work_id=?", trackedID)
	metadataReviewExec(t, db, "INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability) VALUES (?,?,'tracked','available')", trackedID, sourceID)
	for index, status := range []string{"relisten", "paused"} {
		metadataReviewExec(t, db, `INSERT INTO user_work_state(user_id,work_id,listening_status)
			SELECT user.id,work.id,? FROM user_account AS user,work
			WHERE user.username=? AND work.primary_code=?`, status, account.DemoUsername, testfixture.WorkCode(testfixture.PrefixRJ, index))
	}
	for _, test := range []struct {
		query string
		total int
		code  string
	}{
		{query: "scope=local&status=all", total: 11},
		{query: "scope=tracked&status=all", total: 1, code: testfixture.WorkCode(testfixture.PrefixRJ, 11)},
		{query: "scope=local&status=relisten", total: 1, code: testfixture.WorkCode(testfixture.PrefixRJ, 0)},
		{query: "scope=local&status=paused", total: 1, code: testfixture.WorkCode(testfixture.PrefixRJ, 1)},
		{query: "scope=tracked&status=relisten", total: 0},
	} {
		var result demoRecommendationTestPage
		decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
			"/api/works?sort=recommend&pageSize=100&seed=17&recommendationSession=synthetic-pagination&"+test.query, nil), &result)
		if result.Total != test.total || len(result.Works) != test.total || test.code != "" && result.Works[0].PrimaryCode != test.code {
			t.Fatalf("Demo scope/status %s returns %+v", test.query, result)
		}
	}
	exactCode := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	metadataReviewExec(t, db, "UPDATE work SET title=? WHERE primary_code=?", "Example "+exactCode, testfixture.WorkCode(testfixture.PrefixRJ, 10))
	metadataReviewExec(t, db, "UPDATE work SET title='Example Match' WHERE primary_code=?", exactCode)
	if err := server.libraryStore.RefreshSearchIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	var exact demoRecommendationTestPage
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		"/api/works?scope=local&sort=recommend&pageSize=100&seed=41&recommendationSession=synthetic-pagination&q="+url.QueryEscape(exactCode), nil), &exact)
	if exact.Total != 1 || len(exact.Works) != 1 || exact.Works[0].PrimaryCode != exactCode {
		t.Fatalf("exact Demo code matches another work's title: %+v", exact)
	}
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		"/api/works?scope=local&sort=recommend&pageSize=100&seed=41&recommendationSession=synthetic-pagination&q="+url.QueryEscape("'Example Match'"), nil), &exact)
	if exact.Total != 6 || len(exact.Works) != 6 || exact.Works[0].PrimaryCode != exactCode {
		t.Fatalf("exact Demo title is not first among partial matches: %+v", exact)
	}
	assertDemoRecommendationStorageUntouched(t, db, server)
}

func TestDemoRecommendationWorkerReturnsWithoutPublishingOrConsumingDirtyQueue(t *testing.T) {
	db, server, _ := newDemoRecommendationFixture(t)
	var before int
	if err := db.QueryRow("SELECT COUNT(*) FROM recommendation_catalog_dirty").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if before == 0 {
		t.Fatal("worker fixture has no backlog")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		server.RunRecommendationWorker(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		cancel()
		<-done
		t.Fatal("Demo starts the real recommendation worker")
	}
	var after int
	if err := db.QueryRow("SELECT COUNT(*) FROM recommendation_catalog_dirty").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("Demo worker consumed dirty queue: %d to%d", before, after)
	}
	assertDemoRecommendationStorageUntouched(t, db, server)
}

func TestDemoRecommendationCanonicalFamilyUsesOneScoreWithoutChangingEditionDetail(t *testing.T) {
	db, server, sourceID := newDemoRecommendationFixture(t)
	canonicalCode := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	editionCode := testfixture.WorkCode(testfixture.PrefixRJ, 14)
	aliasCode := testfixture.WorkCode(testfixture.PrefixRJ, 15)
	legacyCode := testfixture.WorkCode(testfixture.PrefixRJ, 16)
	var canonicalID int64
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code=?", canonicalCode).Scan(&canonicalID); err != nil {
		t.Fatal(err)
	}
	editionID := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title,age_rating,is_permanently_free) VALUES (?,'Example Translation','general',1)", editionCode)
	metadataReviewExec(t, db, `INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability)
		SELECT ?,id,'local','available' FROM file_source WHERE code='example_local'`, editionID)
	logicalID := metadataReviewExec(t, db, "INSERT INTO logical_work(canonical_work_id,canonical_code) VALUES (?,?)", canonicalID, canonicalCode)
	metadataReviewExec(t, db, `INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,base_code,metadata_language,is_canonical)
		VALUES (?,?,2,?,'','JPN',1),(?,?,2,?,?,'ENG',0)`, canonicalID, logicalID, canonicalCode, editionID, logicalID, editionCode, canonicalCode)
	metadataReviewExec(t, db, "INSERT INTO work_code_alias(logical_work_id,provider_id,primary_code,source_work_id) VALUES (?,2,?,?)", logicalID, aliasCode, editionID)
	// A compatibility edition can carry its family only in raw metadata. Its
	// lack of an edition projection must not create short pages or wrong totals.
	legacyID := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title,age_rating,is_permanently_free) VALUES (?,'Example Legacy Translation','general',1)", legacyCode)
	metadataReviewExec(t, db, `INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability)
		SELECT ?,id,'local','available' FROM file_source WHERE code='example_local'`, legacyID)
	metadataReviewExec(t, db, "INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability) VALUES (?,?,?,'available')", legacyID, sourceID, sourcePresenceTypeRemoteSource)
	rawSnapshot, err := json.Marshal(map[string]string{"workno": legacyCode, "base_code": canonicalCode})
	if err != nil {
		t.Fatal(err)
	}
	snapshotID := metadataReviewExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) VALUES (?,2,?,?)", legacyID, legacyCode, string(rawSnapshot))
	var projected int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_edition WHERE work_id=?", legacyID).Scan(&projected); err != nil {
		t.Fatal(err)
	}
	if projected != 0 {
		t.Fatal("legacy fixture unexpectedly has an edition projection")
	}
	handler := server.Routes()
	session := "synthetic-family-session"
	var page demoRecommendationTestPage
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
		"/api/works?scope=local&sort=recommend&pageSize=100&recommendationSession="+session, nil), &page)
	if page.Total != 12 || len(page.Works) != 12 {
		t.Fatalf("Demo family creates a second Library identity: %+v", page)
	}
	canonicalScore := -1
	for _, work := range page.Works {
		if work.PrimaryCode == canonicalCode {
			canonicalScore = work.RecommendScore
		}
		if work.PrimaryCode == editionCode || work.PrimaryCode == aliasCode || work.PrimaryCode == legacyCode {
			t.Fatalf("Demo Library materializes another family identity: %+v", work)
		}
	}
	if canonicalScore < 0 || canonicalScore > 100 {
		t.Fatalf("canonical Demo score unavailable: %d", canonicalScore)
	}
	for _, edition := range []struct {
		id   int64
		code string
	}{{editionID, editionCode}, {legacyID, legacyCode}} {
		var detail demoRecommendationTestCard
		decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
			fmt.Sprintf("/api/works/%d?includeMedia=false&recommendationSession=%s", edition.id, session), nil), &detail)
		// The title-language preference can select the family's origin title.
		// Numeric detail retains the explicitly requested edition identity.
		if detail.ID != edition.id || detail.PrimaryCode != edition.code || detail.RecommendScore != canonicalScore {
			t.Fatalf("numeric edition identity or family score changes: %+v, canonical score %d", detail, canonicalScore)
		}
		var explanation struct {
			Score     int    `json:"score"`
			ScoreKind string `json:"scoreKind"`
		}
		decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
			fmt.Sprintf("/api/works/%d/recommendation?recommendationSession=%s", edition.id, session), nil), &explanation)
		if explanation.Score != canonicalScore || explanation.ScoreKind != "demo_random" {
			t.Fatalf("edition explanation disagrees with family: %+v", explanation)
		}
	}
	var scored struct {
		Scores []remoteRecommendationScore `json:"scores"`
	}
	decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodPost,
		fmt.Sprintf("/api/remote-sources/%d/recommendations", sourceID), remoteRecommendationRequest{
			SessionID: session,
			Works:     []library.RecommendationCandidate{{PrimaryCode: editionCode}, {PrimaryCode: aliasCode}, {PrimaryCode: legacyCode}},
		}), &scored)
	if len(scored.Scores) != 3 {
		t.Fatalf("Demo family remote score count %d", len(scored.Scores))
	}
	for _, score := range scored.Scores {
		if score.Score != canonicalScore {
			t.Fatalf("Demo remote edition/alias disagrees with family: %+v", scored.Scores)
		}
	}
	for _, phase := range []string{"raw_snapshot", "current_summary", "expired_summary"} {
		if phase == "current_summary" {
			summary, err := json.Marshal(map[string]any{"v": library.SnapshotCardSummaryVersion, "baseCode": canonicalCode})
			if err != nil {
				t.Fatal(err)
			}
			metadataReviewExec(t, db, "INSERT INTO metadata_snapshot_card_summary(snapshot_id,version,summary_json) VALUES (?,?,?)", snapshotID, library.SnapshotCardSummaryVersion, string(summary))
		}
		if phase == "expired_summary" {
			stale, err := json.Marshal(map[string]any{"v": 0, "baseCode": testfixture.WorkCode(testfixture.PrefixRJ, 99)})
			if err != nil {
				t.Fatal(err)
			}
			metadataReviewExec(t, db, "UPDATE metadata_snapshot_card_summary SET version=0,summary_json=? WHERE snapshot_id=?", string(stale), snapshotID)
		}
		for _, target := range []string{"/api/works?scope=local&sort=recommend", fmt.Sprintf("/api/remote-sources/%d/works?sort=random&recommendBadges=true", sourceID)} {
			seen := map[string]bool{}
			for number := 1; number <= 4; number++ {
				var result demoRecommendationTestPage
				decodeDemoRecommendationResponse(t, demoRecommendationRequest(t, handler, http.MethodGet,
					target+"&recommendationSession="+session+"&seed=17&pageSize=4&page="+strconv.Itoa(number), nil), &result)
				wantRows := 4
				if number == 4 {
					wantRows = 0
				}
				if result.Total != 12 || len(result.Works) != wantRows || result.RecommendationUnavailable {
					t.Fatalf("%s Demo family page %d: total %d, rows %d", phase, number, result.Total, len(result.Works))
				}
				for _, work := range result.Works {
					if seen[work.PrimaryCode] || work.PrimaryCode == legacyCode || work.PrimaryCode == editionCode {
						t.Fatalf("%s exposes duplicate/family edition card: %+v", phase, work)
					}
					seen[work.PrimaryCode] = true
				}
			}
			if len(seen) != 12 {
				t.Fatalf("%s Demo family pages contain %d works", phase, len(seen))
			}
		}
	}
	var works int
	if err := db.QueryRow("SELECT COUNT(*) FROM work").Scan(&works); err != nil {
		t.Fatal(err)
	}
	if works != 16 {
		t.Fatalf("alias score materializes work identity: %d works", works)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_edition WHERE work_id=?", legacyID).Scan(&projected); err != nil {
		t.Fatal(err)
	}
	if projected != 0 {
		t.Fatal("Demo reads materialize the legacy edition projection")
	}
	assertDemoRecommendationStorageUntouched(t, db, server)
}
