package httpapi

import (
	"testing"
	"time"
)

func TestCatalogFreshnessState(t *testing.T) {
	now := time.Date(2026, time.August, 12, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name          string
		lastSuccessAt string
		lastAttemptAt string
		wantState     string
		wantReason    string
	}{
		{name: "never pulled", wantState: catalogSyncNever, wantReason: "never"},
		{
			name:          "attempt without success",
			lastAttemptAt: now.Add(-time.Hour).Format(time.RFC3339),
			wantState:     catalogSyncAttention,
			wantReason:    "no_successful_pull",
		},
		{
			name:          "within freshness window",
			lastSuccessAt: now.Add(-29 * 24 * time.Hour).Format(time.RFC3339),
			wantState:     catalogSyncSynced,
		},
		{
			name:          "freshness window elapsed",
			lastSuccessAt: now.Add(-30 * 24 * time.Hour).Format(time.RFC3339),
			wantState:     catalogSyncAttention,
			wantReason:    "stale",
		},
		{
			name:          "invalid success timestamp",
			lastSuccessAt: "not-a-time",
			wantState:     catalogSyncAttention,
			wantReason:    "invalid_timestamp",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			state, reason := catalogFreshnessState(test.lastSuccessAt, test.lastAttemptAt, 30, now)
			if state != test.wantState || reason != test.wantReason {
				t.Fatalf("catalog freshness = %q/%q, want %q/%q", state, reason, test.wantState, test.wantReason)
			}
		})
	}
}

func TestVoiceCatalogSyncStateMarksIncompleteAndChangedAliasesForAttention(t *testing.T) {
	now := time.Date(2026, time.August, 12, 9, 0, 0, 0, time.UTC)
	lastSuccess := now.Add(-time.Hour).Format(time.RFC3339)
	item := voiceSummary{DisplayName: "Example Voice", Aliases: []string{"Example Voice Alias"}}
	projection := voiceCatalogSyncProjection{
		Queries:       []string{"Example Voice", "Example Voice Alias"},
		LastSuccessAt: lastSuccess,
		LastAttemptAt: lastSuccess,
		Complete:      true,
	}

	setVoiceCatalogSyncState(&item, projection, 30, now)
	if item.SyncState != catalogSyncSynced || item.SyncReason != "" {
		t.Fatalf("initial voice state = %q/%q, want synced", item.SyncState, item.SyncReason)
	}

	projection.Complete = false
	setVoiceCatalogSyncState(&item, projection, 30, now)
	if item.SyncState != catalogSyncAttention || item.SyncReason != "incomplete" {
		t.Fatalf("incomplete voice state = %q/%q, want attention/incomplete", item.SyncState, item.SyncReason)
	}

	projection.Complete = true
	projection.Queries = []string{"Example Voice"}
	setVoiceCatalogSyncState(&item, projection, 30, now)
	if item.SyncState != catalogSyncAttention || item.SyncReason != "aliases_changed" {
		t.Fatalf("changed aliases state = %q/%q, want attention/aliases_changed", item.SyncState, item.SyncReason)
	}
}
