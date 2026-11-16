package httpapi

import (
	"context"
	"net/http"
	"reflect"
	"testing"
	"time"
)

func TestCreatorReleaseRecencyRequiresARecentValidDate(t *testing.T) {
	now := time.Date(2026, time.November, 16, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		date string
		want bool
	}{
		{date: "2026-11-16", want: true},
		{date: "2026-10-17", want: true},
		{date: "2026-10-16", want: false},
		{date: "", want: false},
		{date: "unknown", want: false},
	} {
		t.Run(test.date, func(t *testing.T) {
			if got := creatorReleaseIsRecent(test.date, now); got != test.want {
				t.Fatalf("release %q recent = %v, want %v", test.date, got, test.want)
			}
		})
	}
}

func TestSubscriptionRefreshRejectsLateDiscoveredOldWorks(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	env.addCircle(t, 10, "RG00001", []string{"RJ00000001"}, recentPull())
	response := env.request(t, env.adminID, http.MethodPost, "/api/subscriptions", map[string]any{"kind": "circle", "circleId": "RG00001"}, env.server.createCreatorSubscription)
	if response.Code != http.StatusCreated {
		t.Fatalf("subscribe = %d %s", response.Code, response.Body.String())
	}
	now := time.Now().UTC()
	if _, err := env.db.Exec("UPDATE creator_subscription SET activated_at = ?", now.AddDate(-1, 0, 0).Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"RJ00000002", "RJ00000003", "RJ00000004", "RJ00000005", "RJ00000006"} {
		env.addCatalogCode(t, 10, code)
	}
	oldDate := now.AddDate(0, 0, -60).Format(time.DateOnly)
	if _, err := env.db.Exec("UPDATE party_catalog_item SET release_date = ? WHERE primary_code = 'RJ00000002'", oldDate); err != nil {
		t.Fatal(err)
	}
	syncer := &fakeFamilySyncer{db: env.db, works: map[string]fakeFamilyWork{
		"RJ00000003": {releaseDate: oldDate, family: "RJ00000003", canonical: true},
		"RJ00000004": {family: "RJ00000004", canonical: true},
		"RJ00000005": {releaseDate: "unknown", family: "RJ00000005", canonical: true},
		"RJ00000006": {releaseDate: now.Format(time.DateOnly), family: "RJ00000006", canonical: true},
	}}
	execution := &creatorSubscriptionExecution{result: creatorSubscriptionRunResult{Failures: []string{}}, feed: map[int64][]string{}}
	if err := env.server.processCreatorReleaseCandidates(context.Background(), 0, syncer, execution); err != nil {
		t.Fatal(err)
	}
	if want := []string{"RJ00000006"}; !reflect.DeepEqual(execution.feed[env.adminID], want) {
		t.Fatalf("new releases = %v, want %v", execution.feed[env.adminID], want)
	}
	if want := []string{"RJ00000006", "RJ00000005", "RJ00000004", "RJ00000003"}; !reflect.DeepEqual(syncer.calls, want) {
		t.Fatalf("metadata requests = %v, want %v", syncer.calls, want)
	}
	if execution.result.NewWorks != 1 || execution.result.FeedItems != 1 {
		t.Fatalf("refresh result = %+v", execution.result)
	}
	candidates, err := env.server.creatorReleaseCandidates(context.Background())
	if err != nil || len(candidates) != 0 {
		t.Fatalf("unsettled candidates = %v, error = %v", candidates, err)
	}
}
