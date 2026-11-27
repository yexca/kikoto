package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/record"
)

func newDemoRecordServer(t *testing.T) (*Server, *int) {
	t.Helper()
	db := openMigratedTestDB(t)
	cacheRoot := t.TempDir()
	s := NewServer(db, config.Config{
		Mode: config.ModeDemo, CacheRoot: cacheRoot,
		RecordRoot: filepath.Join(cacheRoot, config.DemoRecordDirName),
	})
	runs := 0
	s.demoRecordFFmpeg = func(_ context.Context, args []string) error {
		runs++
		return os.WriteFile(args[len(args)-1], []byte("sample"), 0o644)
	}
	ctx := context.Background()
	if err := s.BootstrapDemo(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.ensureSystemWorkflowDefinitions(ctx); err != nil {
		t.Fatal(err)
	}
	return s, &runs
}

func TestDemoStartupServesTheGeneratedRecordLibrary(t *testing.T) {
	s, runs := newDemoRecordServer(t)
	ctx := context.Background()
	if err := s.prepareDemoRecordLibrary(ctx); err != nil {
		t.Fatalf("prepareDemoRecordLibrary() = %v", err)
	}
	if !s.recordLibraryEnabled(ctx) {
		t.Fatal("Record stayed off after the demo library was prepared")
	}
	demo, err := s.accountStore.LoadByUsername(ctx, account.DemoUsername)
	if err != nil {
		t.Fatal(err)
	}

	view, err := s.recordStore.FolderView(ctx, 0, record.SectionPageMax, demo.ID)
	if err != nil {
		t.Fatal(err)
	}
	var folders []string
	for _, page := range view.Sections {
		for _, folder := range page.Folders {
			folders = append(folders, folder.Name)
		}
	}
	if want := []string{"Sample audio", "Sample clips", "Sample trip"}; !reflect.DeepEqual(folders, want) {
		t.Fatalf("root folders = %v, want %v", folders, want)
	}

	// Continue watching lists the files left part way, the latest first.
	continuing, err := s.recordStore.ContinueWatching(ctx, demo.ID, 12)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, asset := range continuing {
		names = append(names, asset.Name)
	}
	if want := []string{"Night market.mkv", "Morning tone.mp3"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("continue watching = %v, want %v", names, want)
	}
	// The seed order decides, not the order the scan numbered the files in.
	reversed := slices.Clone(demoRecordProgress)
	slices.Reverse(reversed)
	if err := s.seedDemoRecordProgress(ctx, reversed); err != nil {
		t.Fatal(err)
	}
	flipped, err := s.recordStore.ContinueWatching(ctx, demo.ID, 12)
	if err != nil {
		t.Fatal(err)
	}
	if len(flipped) != 2 || flipped[0].Name != "Morning tone.mp3" {
		t.Fatalf("continue watching after reversed seeds = %+v, want Morning tone.mp3 first", flipped)
	}

	// A restart keeps the generated files and the catalog's identities.
	before := *runs
	if err := s.prepareDemoRecordLibrary(ctx); err != nil {
		t.Fatalf("second prepareDemoRecordLibrary() = %v", err)
	}
	if *runs != before {
		t.Fatalf("a restart ran ffmpeg %d more times", *runs-before)
	}
	again, err := s.recordStore.ContinueWatching(ctx, demo.ID, 12)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != len(continuing) || again[0].ID != continuing[0].ID {
		t.Fatalf("continue watching after a restart = %+v, want the same files", again)
	}

	// Visitors still change nothing in the Record library.
	id := strconv.FormatInt(continuing[0].ID, 10)
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodPost, "/api/records/scans", nil),
		httptest.NewRequest(http.MethodPost, "/api/records/probes", nil),
		httptest.NewRequest(http.MethodPost, "/api/records/root/initialize", strings.NewReader(`{"fresh":true}`)),
		httptest.NewRequest(http.MethodPut, "/api/records/assets/"+id+"/progress", strings.NewReader(`{"positionSeconds":1}`)),
		httptest.NewRequest(http.MethodDelete, "/api/records/assets/"+id+"?path=x", nil),
	} {
		response := httptest.NewRecorder()
		s.Routes().ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"demo_read_only"`) {
			t.Fatalf("%s %s = %d %s, want demo_read_only", request.Method, request.URL.Path, response.Code, response.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(s.cfg.RecordRoot, "Sample trip", "Day 2", "Night market.mkv")); err != nil {
		t.Fatalf("sample file after rejected writes: %v", err)
	}
}

func TestDemoStartsWithoutRecordWhenItsSamplesCannotBeMade(t *testing.T) {
	s, _ := newDemoRecordServer(t)
	ctx := context.Background()
	if err := s.saveSettingValue(ctx, recordLibraryEnabledSetting, true); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("encoder missing")
	s.demoRecordFFmpeg = func(context.Context, []string) error { return failure }
	if err := s.prepareDemoRecordLibrary(ctx); !errors.Is(err, failure) {
		t.Fatalf("prepareDemoRecordLibrary() = %v, want the ffmpeg failure", err)
	}
	if s.recordLibraryEnabled(ctx) {
		t.Fatal("Record stayed on without its samples")
	}
}
