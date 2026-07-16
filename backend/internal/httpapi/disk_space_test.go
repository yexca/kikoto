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
	target := filepath.Join(dataRoot, "library", "RJ09999991")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "existing.bin"), make([]byte, 64), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	size := int64(32)
	plan := remoteWorkSavePlan{SaveRoot: "library/RJ09999991", Items: []remoteWorkSavePlanItem{{Action: "cache_download", SizeBytes: &size}}}
	if err := server.ensureRemoteWorkSaveDiskReserve(plan, 1); err != nil {
		t.Fatalf("small reserve: %v", err)
	}
	if err := server.ensureRemoteWorkSaveDiskReserve(plan, math.MaxInt64); err == nil || !strings.Contains(err.Error(), "insufficient free space") {
		t.Fatalf("huge reserve error = %v", err)
	}
}
