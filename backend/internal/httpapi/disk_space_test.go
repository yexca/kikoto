package httpapi

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestRemoteWorkSaveRequiredBytesSeparatesDataAndCache(t *testing.T) {
	one := int64(100)
	two := int64(250)
	plan := remoteWorkSavePlan{Items: []remoteWorkSavePlanItem{
		{Action: "cache_download", SizeBytes: &one},
		{Action: "cache_hit", SizeBytes: &two},
		{Action: "skip", SizeBytes: &two},
	}}
	dataBytes, cacheBytes, err := remoteWorkSaveRequiredBytes(plan)
	if err != nil {
		t.Fatal(err)
	}
	if dataBytes != 350 || cacheBytes != 100 {
		t.Fatalf("required bytes = data %d cache %d", dataBytes, cacheBytes)
	}
	plan.Items[0].SizeBytes = nil
	if _, _, err := remoteWorkSaveRequiredBytes(plan); err == nil || !strings.Contains(err.Error(), "known file sizes") {
		t.Fatalf("unknown size error = %v", err)
	}
}

func TestEnsureRemoteWorkSaveDiskReserveCountsExistingTarget(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	cacheRoot := filepath.Join(root, "cache")
	target := filepath.Join(dataRoot, "library", "RJ00000000")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "existing.bin"), make([]byte, 64), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	size := int64(32)
	plan := remoteWorkSavePlan{SaveRoot: "library/RJ00000000", Items: []remoteWorkSavePlanItem{{Action: "cache_download", SizeBytes: &size}}}
	if err := server.ensureRemoteWorkSaveDiskReserve(plan, 1, ""); err != nil {
		t.Fatalf("small reserve: %v", err)
	}
	if err := server.ensureRemoteWorkSaveDiskReserve(plan, math.MaxInt64, ""); err == nil || !strings.Contains(err.Error(), "insufficient free space") {
		t.Fatalf("huge reserve error = %v", err)
	}
}

func TestRemoteWorkSaveDiskNeedsSkipsCachedAndStagedBytes(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	cacheRoot := filepath.Join(root, "cache")
	write := func(path string, size int) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	size := func(value int64) *int64 { return &value }
	plan := remoteWorkSavePlan{SaveRoot: "library/RJ00000001", Items: []remoteWorkSavePlanItem{
		{Action: "cache_download", CachePath: "media/RJ00000001/cached.wav", SizeBytes: size(100)},
		{Action: "cache_download", CachePath: "media/RJ00000001/missing.wav", SizeBytes: size(300)},
		{Action: "cache_download", CachePath: "media/RJ00000001/partial.wav", SizeBytes: size(50)},
	}}
	write(filepath.Join(cacheRoot, "media", "RJ00000001", "cached.wav"), 100)
	write(filepath.Join(cacheRoot, "media", "RJ00000001", "partial.wav"), 40)
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})

	dataBytes, cacheBytes, err := server.remoteWorkSaveDiskNeeds(plan, "")
	if err != nil || dataBytes != 450 || cacheBytes != 350 {
		t.Fatalf("fresh needs = data %d cache %d, %v", dataBytes, cacheBytes, err)
	}

	write(filepath.Join(dataRoot, "staging", "7", "work", "cached.wav"), 100)
	dataBytes, _, err = server.remoteWorkSaveDiskNeeds(plan, "staging/7/work")
	if err != nil || dataBytes != 450 {
		t.Fatalf("small staging needs = data %d, %v; headroom must not exceed what is staged", dataBytes, err)
	}

	write(filepath.Join(dataRoot, "staging", "7", "work", "missing.wav"), 300)
	dataBytes, _, err = server.remoteWorkSaveDiskNeeds(plan, "staging/7/work")
	if err != nil || dataBytes != 450-400+300 {
		t.Fatalf("restaged needs = data %d, %v", dataBytes, err)
	}
}
