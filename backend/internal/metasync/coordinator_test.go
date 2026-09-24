package metasync

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

type blockingMetadataClient struct {
	mu          sync.Mutex
	calls       map[string]int
	entered     chan string
	release     chan struct{}
	blockedCode string
}

func (c *blockingMetadataClient) FetchProduct(ctx context.Context, code string) (dlsite.Product, error) {
	c.mu.Lock()
	c.calls[code]++
	c.mu.Unlock()
	c.entered <- code
	if code == c.blockedCode {
		select {
		case <-ctx.Done():
			return dlsite.Product{}, ctx.Err()
		case <-c.release:
		}
	}
	return dlsite.Product{WorkNo: code, ProductName: "Synthetic metadata", Language: "ja-jp"}, nil
}
func (*blockingMetadataClient) DownloadCover(context.Context, dlsite.Product, string) (string, error) {
	return "", nil
}

func TestSharedMetadataCoordinatorJoinsWorkAndAllowsOtherWorks(t *testing.T) {
	db := openTestDB(t)
	db.SetMaxOpenConns(1)
	code := testfixture.WorkCode(testfixture.PrefixRJ, 4)
	other := testfixture.WorkCode(testfixture.PrefixRJ, 5)
	client := &blockingMetadataClient{calls: map[string]int{}, entered: make(chan string, 10), release: make(chan struct{}), blockedCode: code}
	coordinator := NewCoordinator()
	newSyncer := func() *DLsiteSyncer {
		return NewDLsiteSyncer(db, client).WithCoordinator(coordinator).WithRequestPacing(0, 0, 0)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	results := make(chan DLsiteFamilySyncResult, 2)
	errs := make(chan error, 2)
	start := func() { result, err := newSyncer().SyncFamily(ctx, code); results <- result; errs <- err }
	go start()
	select {
	case <-client.entered:
	case <-ctx.Done():
		t.Fatal("first fetch never started")
	}
	go start()
	// A separate family must finish while the first provider request is blocked.
	if _, err := newSyncer().SyncFamily(ctx, other); err != nil {
		t.Fatal(err)
	}
	if !coordinator.IsRunning(code) {
		t.Fatal("active family is not visible")
	}
	// Waiting cancellation must leave the leader alive and its result reusable.
	waitCtx, stop := context.WithTimeout(ctx, 50*time.Millisecond)
	_, err := newSyncer().SyncFamily(waitCtx, code)
	stop()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancelled waiter error=%v", err)
	}
	close(client.release)
	var attempts []int64
	for range 2 {
		select {
		case result := <-results:
			attempts = append(attempts, result.attempt)
		case <-ctx.Done():
			t.Fatal("sync did not finish")
		}
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	client.mu.Lock()
	calls := client.calls[code]
	client.mu.Unlock()
	if calls != 1 || attempts[0] != attempts[1] {
		t.Fatalf("same work fetched %d times, attempts=%v", calls, attempts)
	}
	if coordinator.IsRunning(code) {
		t.Fatal("completed family remains busy")
	}
}

func TestProductGateCancellationDoesNotLeakOrBlockAnotherCode(t *testing.T) {
	c := NewCoordinator()
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	release, err := c.acquireProduct(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.acquireProduct(ctx, code); !errors.Is(err, context.Canceled) {
		t.Fatalf("wait=%v", err)
	}
	otherRelease, err := c.acquireProduct(context.Background(), testfixture.WorkCode(testfixture.PrefixRJ, 1))
	if err != nil {
		t.Fatal(err)
	}
	otherRelease()
	release()
	release, err = c.acquireProduct(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	release()
	if len(c.products) != 0 {
		t.Fatal("completed gates retained")
	}
}

func TestJoinedFamilySyncWithAnotherPriorityReprojectsWithoutRefetch(t *testing.T) {
	db := openTestDB(t)
	origin := testfixture.WorkCode(testfixture.PrefixRJ, 30)
	english := testfixture.WorkCode(testfixture.PrefixRJ, 31)
	editions := []dlsite.LanguageEdition{
		{WorkNo: origin, DisplayOrder: 1, Label: "Japanese", Lang: "JPN"},
		{WorkNo: english, DisplayOrder: 2, Label: "English", Lang: "ENG"},
	}
	product := func(code, title string) dlsite.Product {
		return dlsite.Product{WorkNo: code, ProductName: title, LanguageEditions: editions}
	}
	client := &localizedFakeDLsiteClient{products: map[string]map[string]dlsite.Product{
		origin:  {"ja-jp": product(origin, "Origin title")},
		english: {"ja-jp": product(english, "English title"), "en-us": product(english, "English title")},
	}}
	coordinator := NewCoordinator()
	newSyncer := func(priority ...string) *DLsiteSyncer {
		return NewDLsiteSyncer(db, client).WithCoordinator(coordinator).
			WithLanguages([]string{"ja-jp"}).WithMetadataPriority(priority).WithRequestPacing(0, 0, 0)
	}
	leader := newSyncer()
	result, err := leader.SyncFamily(context.Background(), origin)
	if err != nil {
		t.Fatal(err)
	}
	calls := len(client.calls)

	// Present the completed sync as still registered so the joining caller
	// deterministically observes it rather than starting its own attempt.
	coordinator.families[origin] = &familyCall{
		requested: origin,
		profile:   strings.Join(leader.languages, "\x00") + "\x01" + leader.cacheRoot,
		priority:  strings.Join(leader.projectionPriority(), "\x00"),
		done:      make(chan struct{}),
		result:    result,
	}
	close(coordinator.families[origin].done)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := newSyncer("en-us").SyncFamily(ctx, origin); err != nil {
		t.Fatalf("priority-only difference did not join: %v", err)
	}
	if len(client.calls) != calls {
		t.Fatalf("joined sync issued provider requests: %v", client.calls[calls:])
	}
	var title string
	if err := db.QueryRow("SELECT title FROM work WHERE primary_code = ?", origin).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "English title" {
		t.Fatalf("projected title = %q, want English title", title)
	}
}
