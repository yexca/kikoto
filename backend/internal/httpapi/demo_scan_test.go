package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
)

func TestRunDemoStartupWorkflowsInitializesVisibleDefinitions(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{
		Mode:           config.ModeDemo,
		DataRoot:       t.TempDir(),
		CacheRoot:      t.TempDir(),
		LocalScanDepth: 2,
	})

	result, err := server.RunDemoStartupWorkflows(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" {
		t.Fatalf("Demo startup scan status = %q, want succeeded", result.Status)
	}

	for _, code := range []string{
		"availability_watch",
		"local_library_scan",
		"metadata_sync",
		"remote_popular_collection",
		"dlsite_popular_collection",
	} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM workflow_definition WHERE code = ?", code).Scan(&count); err != nil {
			t.Fatalf("count workflow definition %s: %v", code, err)
		}
		if count != 1 {
			t.Fatalf("workflow definition %s count = %d, want 1", code, count)
		}
	}

	var demoRuns, otherRuns int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", demoLibraryScanWorkflowCode).Scan(&demoRuns); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code <> ?", demoLibraryScanWorkflowCode).Scan(&otherRuns); err != nil {
		t.Fatal(err)
	}
	if demoRuns != 1 || otherRuns != 0 {
		t.Fatalf("Demo startup runs = demo %d, other %d; want demo 1 and other 0", demoRuns, otherRuns)
	}
}

func TestRunDemoStartupWorkflowsRejectsNonDemoMode(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction})

	if _, err := server.RunDemoStartupWorkflows(context.Background()); err == nil {
		t.Fatal("RunDemoStartupWorkflows() succeeded outside Demo mode")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_definition WHERE code = 'remote_popular_collection'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("non-Demo startup inserted %d Demo catalog definitions", count)
	}
}

func TestDemoLibraryScanOnlyStoresEligibleWorks(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	products := map[string]dlsite.Product{
		"RJ00000000": demoScanProduct("RJ00000000", "Eligible", "general", int64Pointer(0), int64Pointer(0), nil),
		"RJ00000001": demoScanProduct("RJ00000001", "Adult free", "adult", int64Pointer(0), int64Pointer(0), nil),
		"RJ00000002": demoScanProduct("RJ00000002", "Paid", "general", int64Pointer(1100), int64Pointer(1100), nil),
		"RJ00000003": demoScanProduct("RJ00000003", "Temporary free", "general", int64Pointer(1100), int64Pointer(0), int64Pointer(100)),
		"RJ00000004": demoScanProduct("RJ00000004", "Unknown price", "general", nil, nil, nil),
	}
	for code := range products {
		writeDemoScanFile(t, dataRoot, code, "track.mp3", "audio "+code)
	}
	writeDemoScanFile(t, dataRoot, "RJ00000005", "track.mp3", "unverified audio")
	eligible := products["RJ00000000"]
	eligible.TranslationInfo.OriginalWorkNo = "RJ00000006"
	products["RJ00000000"] = eligible

	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work (primary_code, title, age_rating, is_permanently_free)
		VALUES ('RJ00000007', 'Stale eligible work', 'general', 1)
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{Mode: config.ModeDemo, DataRoot: dataRoot, CacheRoot: t.TempDir(), LocalScanDepth: 2})
	client := &fakeDemoScanDLsiteClient{
		products: products,
		errors:   map[string]error{"RJ00000005": errors.New("provider unavailable")},
		calls:    map[string]int{},
	}
	server.dlsiteClient = client

	result, err := server.RunDemoLibraryScan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "partial" || result.DetectedWorks != 6 || result.EligibleWorks != 1 || result.DiscardedWorks != 4 || result.FailedWorks != 1 || result.IndexedFiles != 1 {
		t.Fatalf("demo scan result = %#v", result)
	}
	if client.coverDownloads != 1 {
		t.Fatalf("Demo scan attempted %d cover downloads, want 1", client.coverDownloads)
	}
	if client.calls["RJ00000006"] != 0 {
		t.Fatalf("Demo scan fetched unverified related product %d times", client.calls["RJ00000006"])
	}

	for _, code := range []string{"RJ00000001", "RJ00000002", "RJ00000003", "RJ00000004", "RJ00000005"} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = ?", code).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("discarded work %s was stored", code)
		}
	}

	listRequest := httptest.NewRequest(http.MethodGet, "/api/works?page=1&pageSize=10", nil)
	listResponse := httptest.NewRecorder()
	server.listWorks(listResponse, listRequest)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listResponse.Code, listResponse.Body.String())
	}
	var page struct {
		Works []libraryWorkSummary `json:"works"`
		Total int                  `json:"total"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Works) != 1 || page.Works[0].PrimaryCode != "RJ00000000" {
		t.Fatalf("Demo library page = %#v", page)
	}
	var voiceCredits int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_credit AS credit
		INNER JOIN work ON work.id = credit.work_id
		WHERE work.primary_code = 'RJ00000000' AND credit.role = 'voice_actor'
	`).Scan(&voiceCredits); err != nil {
		t.Fatal(err)
	}
	if voiceCredits != 1 {
		t.Fatalf("Demo voice credits = %d, want 1", voiceCredits)
	}

	var locationID int64
	if err := db.QueryRow(`
		SELECT location.id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		WHERE work.primary_code = 'RJ00000000' AND location.availability = 'available'
	`).Scan(&locationID); err != nil {
		t.Fatal(err)
	}
	streamRequest := httptest.NewRequest(http.MethodGet, "/api/media/"+strconv.FormatInt(locationID, 10)+"/stream", nil)
	streamRequest.SetPathValue("id", strconv.FormatInt(locationID, 10))
	streamResponse := httptest.NewRecorder()
	server.streamMedia(streamResponse, streamRequest)
	if streamResponse.Code != http.StatusOK || streamResponse.Body.String() != "audio RJ00000000" {
		t.Fatalf("stream status = %d, body = %q", streamResponse.Code, streamResponse.Body.String())
	}

	second, err := server.RunDemoLibraryScan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.EligibleWorks != 1 || second.IndexedFiles != 1 {
		t.Fatalf("second demo scan = %#v", second)
	}
	if client.coverDownloads != 2 {
		t.Fatalf("second Demo scan attempted %d cover downloads, want 2", client.coverDownloads)
	}
	var works, locations, demoRuns, ordinaryRuns int
	if err := db.QueryRow("SELECT COUNT(*) FROM work").Scan(&works); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM media_file_location").Scan(&locations); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", demoLibraryScanWorkflowCode).Scan(&demoRuns); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code <> ?", demoLibraryScanWorkflowCode).Scan(&ordinaryRuns); err != nil {
		t.Fatal(err)
	}
	if works != 2 || locations != 1 || demoRuns != 2 || ordinaryRuns != 0 {
		t.Fatalf("idempotence counts: works=%d locations=%d demoRuns=%d ordinaryRuns=%d", works, locations, demoRuns, ordinaryRuns)
	}
}

func TestDemoLibraryScanStoresEligibleLanguageEditionMetadata(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	writeDemoScanFile(t, dataRoot, "RJ00000010", "track.mp3", "localized audio")

	editions := []dlsite.LanguageEdition{
		{WorkNo: "RJ00000010", DisplayOrder: 1, Label: "Japanese", Lang: "JPN"},
		{WorkNo: "RJ00000011", DisplayOrder: 2, Label: "Simplified Chinese", Lang: "CHI_HANS"},
		{WorkNo: "RJ00000012", DisplayOrder: 3, Label: "English", Lang: "ENG"},
		{WorkNo: "RJ00000013", DisplayOrder: 4, Label: "Korean", Lang: "KO_KR"},
	}
	withEditions := func(product dlsite.Product) dlsite.Product {
		product.LanguageEditions = editions
		return product
	}
	origin := withEditions(demoScanProduct("RJ00000010", "Origin title", "general", int64Pointer(0), int64Pointer(0), nil))
	simplified := withEditions(demoScanProduct("RJ00000011", "Simplified title", "general", int64Pointer(0), int64Pointer(0), nil))
	adult := withEditions(demoScanProduct("RJ00000012", "Adult title", "adult", int64Pointer(0), int64Pointer(0), nil))
	paid := withEditions(demoScanProduct("RJ00000013", "Paid title", "general", int64Pointer(1000), int64Pointer(1000), nil))

	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('dlsite_metadata_languages', '["zh-cn","origin"]')`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{Mode: config.ModeDemo, DataRoot: dataRoot, CacheRoot: t.TempDir(), LocalScanDepth: 2})
	client := &localizedDemoScanDLsiteClient{
		fakeDemoScanDLsiteClient: &fakeDemoScanDLsiteClient{products: map[string]dlsite.Product{
			"RJ00000010": origin,
			"RJ00000011": simplified,
			"RJ00000012": adult,
			"RJ00000013": paid,
		}, calls: map[string]int{}},
		localizedProducts: map[string]map[string]dlsite.Product{
			"RJ00000011": {"zh-cn": simplified},
			"RJ00000012": {"en-us": adult},
			"RJ00000013": {"ko-kr": paid},
		},
	}
	server.dlsiteClient = client

	result, err := server.RunDemoLibraryScan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.EligibleWorks != 1 || result.DiscardedWorks != 0 || result.FailedWorks != 0 || result.IndexedFiles != 1 {
		t.Fatalf("demo scan result = %#v", result)
	}
	if client.coverDownloads != 1 {
		t.Fatalf("cover downloads = %d, want 1 for the local work only", client.coverDownloads)
	}

	var rootTitle string
	if err := db.QueryRow("SELECT title FROM work WHERE primary_code = 'RJ00000010'").Scan(&rootTitle); err != nil {
		t.Fatal(err)
	}
	if rootTitle != "Simplified title" {
		t.Fatalf("projected Demo title = %q, want Simplified title", rootTitle)
	}
	var requestLocale, localizedTitle string
	if err := db.QueryRow(`
		SELECT variant.request_locale, variant.title
		FROM dlsite_metadata_variant AS variant
		INNER JOIN work ON work.id = variant.work_id
		WHERE work.primary_code = 'RJ00000011'
	`).Scan(&requestLocale, &localizedTitle); err != nil {
		t.Fatal(err)
	}
	if requestLocale != "zh-cn" || localizedTitle != "Simplified title" {
		t.Fatalf("localized metadata = locale %q/title %q", requestLocale, localizedTitle)
	}
	if !strings.Contains(strings.Join(client.localeCalls, ","), "RJ00000011:zh-cn") {
		t.Fatalf("exact locale calls = %v, want simplified Chinese request", client.localeCalls)
	}

	for _, code := range []string{"RJ00000012", "RJ00000013"} {
		var works, variants, locations int
		if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = ?", code).Scan(&works); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(`
			SELECT COUNT(*)
			FROM dlsite_metadata_variant AS variant
			INNER JOIN work ON work.id = variant.work_id
			WHERE work.primary_code = ?
		`, code).Scan(&variants); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(`
			SELECT COUNT(*)
			FROM media_file_location AS location
			INNER JOIN media_item AS item ON item.id = location.media_item_id
			INNER JOIN work ON work.id = item.work_id
			WHERE work.primary_code = ?
		`, code).Scan(&locations); err != nil {
			t.Fatal(err)
		}
		if works != 0 || variants != 0 || locations != 0 {
			t.Fatalf("ineligible sibling %s persisted work=%d variant=%d location=%d", code, works, variants, locations)
		}
	}

	var siblingLocations int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		WHERE work.primary_code = 'RJ00000011'
	`).Scan(&siblingLocations); err != nil {
		t.Fatal(err)
	}
	if siblingLocations != 0 {
		t.Fatalf("metadata-only sibling locations = %d, want 0", siblingLocations)
	}
}

func TestDemoLibraryScanKeepsEligibleLocalWorkWhenLanguageEditionFetchFails(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	writeDemoScanFile(t, dataRoot, "RJ00000014", "track.mp3", "fallback audio")
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	editions := []dlsite.LanguageEdition{
		{WorkNo: "RJ00000014", DisplayOrder: 1, Label: "Japanese", Lang: "JPN"},
		{WorkNo: "RJ00000015", DisplayOrder: 2, Label: "Simplified Chinese", Lang: "CHI_HANS"},
	}
	origin := demoScanProduct("RJ00000014", "Fallback origin", "general", int64Pointer(0), int64Pointer(0), nil)
	origin.LanguageEditions = editions
	sibling := demoScanProduct("RJ00000015", "Unavailable localized title", "general", int64Pointer(0), int64Pointer(0), nil)
	sibling.LanguageEditions = editions
	client := &localizedDemoScanDLsiteClient{fakeDemoScanDLsiteClient: &fakeDemoScanDLsiteClient{
		products: map[string]dlsite.Product{
			"RJ00000014": origin,
			"RJ00000015": sibling,
		},
		calls: map[string]int{},
	}}
	server := NewServer(db, config.Config{Mode: config.ModeDemo, DataRoot: dataRoot, LocalScanDepth: 2})
	server.dlsiteClient = client

	result, err := server.RunDemoLibraryScan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "partial" || result.EligibleWorks != 1 || result.FailedWorks != 0 || result.IndexedFiles != 1 || len(result.Failures) != 1 {
		t.Fatalf("demo scan result = %#v", result)
	}
	if !strings.Contains(result.Failures[0], "RJ00000015") {
		t.Fatalf("language edition failure = %q", result.Failures[0])
	}
	var workCount, locationCount, siblingCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = 'RJ00000014'").Scan(&workCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		WHERE work.primary_code = 'RJ00000014'
	`).Scan(&locationCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = 'RJ00000015'").Scan(&siblingCount); err != nil {
		t.Fatal(err)
	}
	if workCount != 1 || locationCount != 1 || siblingCount != 0 {
		t.Fatalf("post-warning persistence = root %d locations %d sibling %d", workCount, locationCount, siblingCount)
	}
}

func TestDemoLibraryScanCannotRunOutsideDemoMode(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{Mode: config.ModeProduction, DataRoot: t.TempDir()})
	if _, err := server.RunDemoLibraryScan(context.Background()); err == nil {
		t.Fatal("RunDemoLibraryScan() succeeded outside Demo mode")
	}
}

type fakeDemoScanDLsiteClient struct {
	products       map[string]dlsite.Product
	errors         map[string]error
	calls          map[string]int
	coverDownloads int
}

func (client *fakeDemoScanDLsiteClient) FetchProduct(ctx context.Context, workno string) (dlsite.Product, error) {
	return client.FetchProductWithOptions(ctx, workno, dlsite.ProductOptions{})
}

func (client *fakeDemoScanDLsiteClient) FetchProductWithOptions(_ context.Context, workno string, _ dlsite.ProductOptions) (dlsite.Product, error) {
	workno = strings.ToUpper(strings.TrimSpace(workno))
	if client.calls != nil {
		client.calls[workno]++
	}
	if err := client.errors[workno]; err != nil {
		return dlsite.Product{}, err
	}
	product, ok := client.products[workno]
	if !ok {
		return dlsite.Product{}, errors.New("product not found")
	}
	return product, nil
}

type localizedDemoScanDLsiteClient struct {
	*fakeDemoScanDLsiteClient
	localizedProducts map[string]map[string]dlsite.Product
	localeCalls       []string
}

func (client *localizedDemoScanDLsiteClient) FetchProductWithLocale(_ context.Context, workno string, locale string) (dlsite.Product, error) {
	workno = strings.ToUpper(strings.TrimSpace(workno))
	locale = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(locale, "_", "-")))
	client.localeCalls = append(client.localeCalls, workno+":"+locale)
	if client.calls != nil {
		client.calls[workno]++
	}
	if err := client.errors[workno]; err != nil {
		return dlsite.Product{}, err
	}
	product, ok := client.localizedProducts[workno][locale]
	if !ok {
		return dlsite.Product{}, dlsite.ErrNoProduct
	}
	product.Language = locale
	product.RequestLocale = locale
	return product, nil
}

func (client *fakeDemoScanDLsiteClient) DownloadCover(context.Context, dlsite.Product, string) (string, error) {
	client.coverDownloads++
	return "", errors.New("cover downloads are disabled in Demo scans")
}

func demoScanProduct(code string, title string, ageRating string, regularPrice *int64, currentPrice *int64, discountRate *int64) dlsite.Product {
	return dlsite.Product{
		WorkNo:            code,
		ProductID:         code,
		ProductName:       title,
		WorkName:          title,
		AgeCategoryString: ageRating,
		RegularPrice:      regularPrice,
		CurrentPrice:      currentPrice,
		DiscountRate:      discountRate,
		Raw:               json.RawMessage(`{"workno":"` + code + `"}`),
	}
}

func writeDemoScanFile(t *testing.T, root string, code string, name string, contents string) {
	t.Helper()
	folder := filepath.Join(root, code+" Demo work")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, name), []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}
