package httpapi

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestAutomaticDatabaseCleanupRunsOnlyRetentionTasks(t *testing.T) {
	want := []string{databaseCleanupTaskExpiredSessions, databaseCleanupTaskOldRuns}
	if !reflect.DeepEqual(databaseAutoCleanupTasks, want) {
		t.Fatalf("automatic tasks = %v, want %v", databaseAutoCleanupTasks, want)
	}
	for _, key := range databaseAutoCleanupTasks {
		if !isDatabaseCleanupTask(key) || databaseCleanupDiskTasks[key] || len(databaseCleanupImpliedTasks[key]) > 0 {
			t.Fatalf("automatic task %q must be a known task without disk checks or implied tasks", key)
		}
	}
}

func TestDatabaseCleanupTasksContinueAfterAFailure(t *testing.T) {
	called := []string{}
	results := runDatabaseCleanupTasks(context.Background(), databaseAutoCleanupTasks, func(_ context.Context, key string) (int, error) {
		called = append(called, key)
		if key == databaseCleanupTaskExpiredSessions {
			return 0, errors.New("database is locked")
		}
		return 3, nil
	})
	if !reflect.DeepEqual(called, databaseAutoCleanupTasks) {
		t.Fatalf("called = %v, want %v", called, databaseAutoCleanupTasks)
	}
	if len(results) != 1 || results[0] != (databaseCleanupTaskResult{Key: databaseCleanupTaskOldRuns, Removed: 3}) {
		t.Fatalf("results = %+v", results)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called = nil
	runDatabaseCleanupTasks(ctx, databaseAutoCleanupTasks, func(_ context.Context, key string) (int, error) {
		called = append(called, key)
		return 0, nil
	})
	if len(called) != 0 {
		t.Fatalf("cancelled cleanup ran %v", called)
	}
}
