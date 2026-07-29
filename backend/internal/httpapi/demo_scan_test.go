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

func TestDemoLibraryScanOnlyStoresEligibleWorks(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	products := map[string]dlsite.Product{
		"RJ02000001": demoScanProduct("RJ02000001", "Eligible", "general", int64Pointer(0), int64Pointer(0), nil),
		"RJ02000002": demoScanProduct("RJ02000002", "Adult free", "adult", int64Pointer(0), int64Pointer(0), nil),
		"RJ02000003": demoScanProduct("RJ02000003", "Paid", "general", int64Pointer(1100), int64Pointer(1100), nil),
		"RJ02000004": demoScanProduct("RJ02000004", "Temporary free", "general", int64Pointer(1100), int64Pointer(0), int64Pointer(100)),
		"RJ02000005": demoScanProduct("RJ02000005", "Unknown price", "general", nil, nil, nil),
	}
	for code := range products {
		writeDemoScanFile(t, dataRoot, code, "track.mp3", "audio "+code)
	}
	writeDemoScanFile(t, dataRoot, "RJ02000006", "track.mp3", "unverified audio")

	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work (primary_code, title, age_rating, is_permanently_free)
		VALUES ('RJ09999999', 'Stale eligible work', 'general', 1)
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{Mode: config.ModeDemo, DataRoot: dataRoot, LocalScanDepth: 2})
	client := &fakeDemoScanDLsiteClient{
		products: products,
		errors:   map[string]error{"RJ02000006": errors.New("provider unavailable")},
	}
	server.dlsiteClient = client

	result, err := server.RunDemoLibraryScan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "partial" || result.DetectedWorks != 6 || result.EligibleWorks != 1 || result.DiscardedWorks != 4 || result.FailedWorks != 1 || result.IndexedFiles != 1 {
		t.Fatalf("demo scan result = %#v", result)
	}
	if client.coverDownloads != 0 {
		t.Fatalf("Demo scan downloaded %d covers", client.coverDownloads)
	}

	for _, code := range []string{"RJ02000002", "RJ02000003", "RJ02000004", "RJ02000005", "RJ02000006"} {
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
	if page.Total != 1 || len(page.Works) != 1 || page.Works[0].PrimaryCode != "RJ02000001" {
		t.Fatalf("Demo library page = %#v", page)
	}

	var locationID int64
	if err := db.QueryRow(`
		SELECT location.id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		WHERE work.primary_code = 'RJ02000001' AND location.availability = 'available'
	`).Scan(&locationID); err != nil {
		t.Fatal(err)
	}
	streamRequest := httptest.NewRequest(http.MethodGet, "/api/media/"+strconv.FormatInt(locationID, 10)+"/stream", nil)
	streamRequest.SetPathValue("id", strconv.FormatInt(locationID, 10))
	streamResponse := httptest.NewRecorder()
	server.streamMedia(streamResponse, streamRequest)
	if streamResponse.Code != http.StatusOK || streamResponse.Body.String() != "audio RJ02000001" {
		t.Fatalf("stream status = %d, body = %q", streamResponse.Code, streamResponse.Body.String())
	}

	second, err := server.RunDemoLibraryScan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.EligibleWorks != 1 || second.IndexedFiles != 1 {
		t.Fatalf("second demo scan = %#v", second)
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

func TestDemoLibraryScanCannotRunOutsideDemoMode(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{Mode: config.ModeProduction, DataRoot: t.TempDir()})
	if _, err := server.RunDemoLibraryScan(context.Background()); err == nil {
		t.Fatal("RunDemoLibraryScan() succeeded outside Demo mode")
	}
}

type fakeDemoScanDLsiteClient struct {
	products       map[string]dlsite.Product
	errors         map[string]error
	coverDownloads int
}

func (client *fakeDemoScanDLsiteClient) FetchProduct(ctx context.Context, workno string) (dlsite.Product, error) {
	return client.FetchProductWithOptions(ctx, workno, dlsite.ProductOptions{})
}

func (client *fakeDemoScanDLsiteClient) FetchProductWithOptions(_ context.Context, workno string, _ dlsite.ProductOptions) (dlsite.Product, error) {
	workno = strings.ToUpper(strings.TrimSpace(workno))
	if err := client.errors[workno]; err != nil {
		return dlsite.Product{}, err
	}
	product, ok := client.products[workno]
	if !ok {
		return dlsite.Product{}, errors.New("product not found")
	}
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
