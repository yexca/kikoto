package library

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestColdRecommendationQueueIsBoundedAndCancellationReleasesPlace(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 1, 0, 0)
	store.recommendationWrite <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { _, err := store.PrepareRecommendationSession(ctx, userID, "example-cancelled"); result <- err }()
	deadline := time.Now().Add(time.Second)
	for len(store.recommendationQueue) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(store.recommendationQueue) != 1 {
		cancel()
		t.Fatal("cold request did not enter the queue")
	}
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled preparation = %v", err)
	}
	if len(store.recommendationQueue) != 0 {
		t.Fatal("cancelled preparation retained its queue place")
	}
	for range cap(store.recommendationQueue) {
		store.recommendationQueue <- struct{}{}
	}
	if _, err := store.PrepareRecommendationSession(context.Background(), userID, "example-overflow"); !errors.Is(err, ErrRecommendationBusy) {
		t.Fatalf("overflow = %v", err)
	}
	for range cap(store.recommendationQueue) {
		<-store.recommendationQueue
	}
	<-store.recommendationWrite
	if _, err := store.PrepareRecommendationSession(context.Background(), userID, "example-success"); err != nil {
		t.Fatal(err)
	}
}
