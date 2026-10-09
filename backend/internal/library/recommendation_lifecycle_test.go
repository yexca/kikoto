package library

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRecommendationPreparationPinsEpochWhileWaitingForCPU(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 3, 0, 0)
	scaleDrainCatalog(t, store)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	epoch, err := store.publishedRecommendationEpoch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	store.recommendationCPU <- struct{}{}
	store.recommendationCPU <- struct{}{}
	defer func() { <-store.recommendationCPU }()
	done := make(chan error, 1)
	go func() {
		_, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-cpu-wait")
		done <- err
	}()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		var staged bool
		if err := store.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM recommendation_generation WHERE catalog_epoch = ? AND ready = 0)", epoch).Scan(&staged); err != nil {
			t.Fatal(err)
		}
		if staged {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("preparation did not pin its epoch before the CPU wait")
		case <-ticker.C:
		}
	}
	if _, err := store.db.ExecContext(ctx, "INSERT INTO work(primary_code,title) VALUES('RJ00000099','Example New Work')"); err != nil {
		t.Fatal(err)
	}
	scaleDrainCatalog(t, store)
	if err := store.CleanupRecommendations(ctx, 64); err != nil {
		t.Fatal(err)
	}
	var retained bool
	if err := store.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM recommendation_catalog_epoch WHERE id = ?)", epoch).Scan(&retained); err != nil || !retained {
		t.Fatalf("waiting preparation lost its epoch: retained=%v err=%v", retained, err)
	}
	<-store.recommendationCPU
	if err := <-done; err != nil {
		t.Fatalf("preparation after catalog publication: %v", err)
	}
}

func TestRecommendationBindingRetriesReclaimedGeneration(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 1, 0, 0)
	scaleDrainCatalog(t, store)
	ctx := context.Background()
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-reclaimed")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, "DELETE FROM recommendation_client_session; UPDATE recommendation_snapshot_state SET current_generation_id = NULL; UPDATE recommendation_generation SET created_at = datetime('now','-2 days') WHERE id = ?", snapshot.GenerationID); err != nil {
		t.Fatal(err)
	}
	for range 4 {
		if err := store.CleanupRecommendations(ctx, 64); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.publishRecommendationBinding(ctx, userID, "synthetic-rebind", snapshot); !errors.Is(err, errRecommendationInputsChanged) {
		t.Fatalf("reclaimed generation binding must retry: %v", err)
	}
	if _, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-rebind"); err != nil {
		t.Fatalf("fresh preparation after reclamation: %v", err)
	}
}
