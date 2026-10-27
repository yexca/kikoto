package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// newBundleFixture stores a bundle RJ00000010 and works of its circle:
// RJ00000011 and RJ00000012 in the bundle's DLsite series, RJ00000013 in
// another series. The series catalog also lists RJ00000014, which is not a
// work.
func newBundleFixture(t *testing.T) (*Server, *sqlutil.DB) {
	t.Helper()
	db := openMigratedTestDB(t)
	snapshot := func(code string, series string) string {
		return `{"product":{"workno":"` + code + `","maker_id":"RG00000001","title_id":"` + series + `"}}`
	}
	statements := []struct {
		query string
		args  []any
	}{
		{query: `INSERT INTO work (id, primary_code, title) VALUES
			(10, 'RJ00000010', 'Example Series Complete Pack'),
			(11, 'RJ00000011', 'Example Work 11'),
			(12, 'RJ00000012', 'Example Work 12'),
			(13, 'RJ00000013', 'Example Work 13')`},
		{query: "INSERT INTO party (id, display_name) VALUES (1, 'Example Circle')"},
		{query: "INSERT INTO work_party (work_id, party_id, role) VALUES (10, 1, 'circle'), (11, 1, 'circle'), (12, 1, 'circle'), (13, 1, 'circle')"},
		{query: "INSERT INTO party_series (id, party_id, provider_id, title_id, name) VALUES (1, 1, 2, 'SRI0000000001', 'Example Series')"},
		{query: "INSERT INTO party_series_work (series_id, primary_code, position) VALUES (1, 'RJ00000014', 0), (1, 'RJ00000010', 1)"},
	}
	for _, item := range []struct {
		workID int64
		code   string
		series string
	}{
		{10, "RJ00000010", "SRI0000000001"},
		{11, "RJ00000011", "SRI0000000001"},
		{12, "RJ00000012", "SRI0000000001"},
		{13, "RJ00000013", "SRI0000000002"},
	} {
		statements = append(statements, struct {
			query string
			args  []any
		}{
			query: "INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, 2, ?, ?)",
			args:  []any{item.workID, item.code, snapshot(item.code, item.series)},
		})
	}
	// One statement per Exec: placeholders do not bind across statements.
	for _, statement := range statements {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	return NewServer(db, config.Config{}), db
}

func bundleRequest(t *testing.T, handler http.HandlerFunc, method string, workID string, code string, permissions ...string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "/api/works/"+workID+"/bundle-members/"+code, nil)
	request.SetPathValue("id", workID)
	request.SetPathValue("code", code)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 0, Permissions: permissions}))
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

func bundleMemberCodes(members []workBundleMember) []string {
	codes := []string{}
	for _, member := range members {
		codes = append(codes, member.Code)
	}
	return codes
}

func TestWorkBundleMembersLinkBothDetailsWithoutJoiningFamilies(t *testing.T) {
	server, db := newBundleFixture(t)
	ctx := context.Background()

	if response := bundleRequest(t, server.addWorkBundleMember, http.MethodPut, "10", "RJ00000011", "library:read"); response.Code != http.StatusForbidden {
		t.Fatalf("add without library:write status = %d", response.Code)
	}
	if response := bundleRequest(t, server.addWorkBundleMember, http.MethodPut, "10", "RJ00000010", "library:write"); response.Code != http.StatusBadRequest {
		t.Fatalf("adding the bundle to itself status = %d", response.Code)
	}
	for _, code := range []string{"rj00000011", "RJ00000014"} {
		if response := bundleRequest(t, server.addWorkBundleMember, http.MethodPut, "10", code, "library:write"); response.Code != http.StatusOK {
			t.Fatalf("add %s status = %d, body = %s", code, response.Code, response.Body.String())
		}
	}

	bundle, err := server.loadWorkDetail(ctx, 0, 10, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := bundleMemberCodes(bundle.BundleMembers); len(got) != 2 || got[0] != "RJ00000011" || got[1] != "RJ00000014" {
		t.Fatalf("bundle members = %v", got)
	}
	if bundle.BundleMembers[0].Work == nil || bundle.BundleMembers[0].Work.ID != 11 {
		t.Fatalf("member in the library is not resolved: %+v", bundle.BundleMembers[0])
	}
	if bundle.BundleMembers[1].Work != nil {
		t.Fatalf("a code outside the library resolved to a work: %+v", bundle.BundleMembers[1])
	}

	member, err := server.loadWorkDetail(ctx, 0, 11, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(member.IncludedIn) != 1 || member.IncludedIn[0].Code != "RJ00000010" || member.IncludedIn[0].Work == nil || member.IncludedIn[0].Work.ID != 10 {
		t.Fatalf("member's bundles = %+v", member.IncludedIn)
	}
	if len(member.BundleMembers) != 0 {
		t.Fatalf("a member lists bundle members: %+v", member.BundleMembers)
	}

	// Membership is not an edition: no family row joins the two works.
	var editions int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_edition WHERE work_id IN (10, 11)").Scan(&editions); err != nil {
		t.Fatal(err)
	}
	if editions != 0 {
		t.Fatalf("membership created %d edition rows", editions)
	}
}

func TestWorkBundleRemovedDetectedMemberStaysRemoved(t *testing.T) {
	server, db := newBundleFixture(t)
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO work_bundle_member (bundle_code, member_code, position, status, origin)
		VALUES ('RJ00000010', 'RJ00000011', 0, 'linked', 'detected'), ('RJ00000010', 'RJ00000012', 1, 'linked', 'user')`); err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"RJ00000011", "RJ00000012"} {
		if response := bundleRequest(t, server.removeWorkBundleMember, http.MethodDelete, "10", code, "library:write"); response.Code != http.StatusOK {
			t.Fatalf("remove %s status = %d, body = %s", code, response.Code, response.Body.String())
		}
	}
	// Detection adds rows only where no decision exists.
	if _, err := db.Exec(`INSERT INTO work_bundle_member (bundle_code, member_code, position, status, origin)
		VALUES ('RJ00000010', 'RJ00000011', 0, 'linked', 'detected')
		ON CONFLICT(bundle_code, member_code) DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	members, err := server.loadWorkBundleMembers(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 0 {
		t.Fatalf("removed members came back: %v", bundleMemberCodes(members))
	}
	var status string
	if err := db.QueryRow("SELECT status FROM work_bundle_member WHERE member_code = 'RJ00000011'").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "dismissed" {
		t.Fatalf("removed detected member status = %q", status)
	}
	var userRows int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_bundle_member WHERE member_code = 'RJ00000012'").Scan(&userRows); err != nil {
		t.Fatal(err)
	}
	if userRows != 0 {
		t.Fatal("a removed member the user added is still stored")
	}

	// Adding a removed member links it again.
	if response := bundleRequest(t, server.addWorkBundleMember, http.MethodPut, "10", "RJ00000011", "library:write"); response.Code != http.StatusOK {
		t.Fatalf("re-add status = %d", response.Code)
	}
	if members, err = server.loadWorkBundleMembers(ctx, 10); err != nil || len(members) != 1 {
		t.Fatalf("re-added members = %v, err = %v", bundleMemberCodes(members), err)
	}
}

func TestWorkBundleCandidatesComeFromTheBundleSeries(t *testing.T) {
	server, db := newBundleFixture(t)
	if _, err := db.Exec(`INSERT INTO work_bundle_member (bundle_code, member_code, position, status, origin)
		VALUES ('RJ00000010', 'RJ00000012', 0, 'dismissed', 'user')`); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/works/10/bundle-candidates", nil)
	request.SetPathValue("id", "10")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 0, Permissions: []string{"library:write"}}))
	response := httptest.NewRecorder()
	server.listWorkBundleCandidates(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result workBundleCandidatesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.LooksLikeBundle || result.SeriesID != "SRI0000000001" {
		t.Fatalf("looksLikeBundle = %v, series = %q", result.LooksLikeBundle, result.SeriesID)
	}
	codes := []string{}
	for _, candidate := range result.Candidates {
		codes = append(codes, candidate.Code)
	}
	// The catalog entry first, then library works of the series; the bundle
	// itself, the removed member, and the other series stay out.
	if len(codes) != 2 || codes[0] != "RJ00000014" || codes[1] != "RJ00000011" {
		t.Fatalf("candidates = %v", codes)
	}
}

func TestTitleNamesBundle(t *testing.T) {
	for title, want := range map[string]bool{
		"⭐30時間⭐ Example コンプリートパック":    true,
		"Example Series 総集編":          true,
		"Example Complete Collection": true,
		"Example Settings":            false,
		"Example Sunset":              false,
		"Example Work":                false,
	} {
		if got := titleNamesBundle(title); got != want {
			t.Errorf("titleNamesBundle(%q) = %v, want %v", title, got, want)
		}
	}
}

func TestWorkBundleRelationsInDemoNameOnlyDemoWorks(t *testing.T) {
	server, db := newBundleFixture(t)
	server.cfg.Mode = config.ModeDemo
	for _, statement := range []string{
		`UPDATE work SET is_permanently_free = 1, age_rating = 'general' WHERE id IN (10, 11)`,
		`INSERT INTO work_bundle_member (bundle_code, member_code, position, status, origin) VALUES
			('RJ00000010', 'RJ00000011', 0, 'linked', 'user'),
			('RJ00000010', 'RJ00000012', 1, 'linked', 'user'),
			('RJ00000010', 'RJ00000014', 2, 'linked', 'user')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	work, err := server.loadWorkDetail(ctx, 0, 10, false)
	if err != nil {
		t.Fatal(err)
	}
	members, _, err := server.demoBundleRelations(ctx, work.BundleMembers, work.IncludedIn)
	if err != nil {
		t.Fatal(err)
	}
	// The paid work and the code outside the library stay out of Demo.
	if got := bundleMemberCodes(members); len(got) != 1 || got[0] != "RJ00000011" {
		t.Fatalf("demo members = %v", got)
	}
}
