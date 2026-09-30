package kikoeru

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func accountTestClient(t *testing.T, server *httptest.Server) *AccountClient {
	t.Helper()
	policy, err := outbound.NewPolicy([]outbound.Destination{{URL: server.URL, AllowPrivate: true}}, outbound.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return NewAccountClient(server.URL, policy.Client(nil, 5*time.Second))
}

func TestAccountClientLogsInAndFollowsServerPageSize(t *testing.T) {
	const serverPageSize = 2
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/me":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if r.Method != http.MethodPost || body["name"] != "synthetic-user" || body["password"] != "synthetic-password" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = fmt.Fprint(w, `{"token":"synthetic-token"}`)
		case "/api/review":
			if r.Header.Get("Authorization") != "Bearer synthetic-token" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			// The server ignores the requested pageSize, like forks with a fixed page size.
			page, _ := strconv.Atoi(r.URL.Query().Get("page"))
			works := []string{}
			for index := (page - 1) * serverPageSize; index < min(page*serverPageSize, 3); index++ {
				works = append(works, fmt.Sprintf(`{"id":%d,"progress":"listened","userRating":4,"review_text":null}`, index))
			}
			_, _ = fmt.Fprintf(w, `{"works":[%s],"pagination":{"currentPage":%d,"pageSize":%d,"totalCount":3}}`, strings.Join(works, ","), page, serverPageSize)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := accountTestClient(t, server)
	if err := client.Login(context.Background(), "synthetic-user", "wrong"); !errors.Is(err, ErrAccountUnauthorized) {
		t.Fatalf("wrong password error = %v", err)
	}
	if err := client.Login(context.Background(), "synthetic-user", "synthetic-password"); err != nil {
		t.Fatal(err)
	}
	reviews, err := client.Reviews(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(reviews) != 3 || string(reviews[2].ID) != "2" || reviews[0].Progress != "listened" || *reviews[0].Rating != 4 {
		t.Fatalf("reviews = %+v", reviews)
	}
	if _, err := client.Reviews(context.Background(), 2); !errors.Is(err, ErrAccountLimit) {
		t.Fatalf("limit error = %v", err)
	}
	if _, err := client.Playlists(context.Background()); !errors.Is(err, ErrAccountUnsupported) {
		t.Fatalf("missing playlist endpoint error = %v", err)
	}
}

func TestAccountClientReadsPlaylistsAndSystemLists(t *testing.T) {
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/playlist/get-playlists":
			if r.URL.Query().Get("filterBy") != "owned" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_, _ = fmt.Fprint(w, `{"playlists":[{"id":"list-a","name":"__SYS_PLAYLIST_LIKED","works_count":1},{"id":7,"name":"Example List","description":"Example description","works_count":0}],"pagination":{"page":1,"pageSize":100,"totalCount":2}}`)
		case "/api/playlist/get-playlist-works":
			if r.URL.Query().Get("id") != "list-a" {
				_, _ = fmt.Fprint(w, `{"works":[],"pagination":{"page":1,"pageSize":100,"totalCount":0}}`)
				return
			}
			_, _ = fmt.Fprintf(w, `{"works":[{"id":1,"source_id":%q}],"pagination":{"page":1,"pageSize":100,"totalCount":1}}`, code)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := accountTestClient(t, server).WithToken("synthetic-token")
	playlists, err := client.Playlists(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(playlists) != 2 || playlists[0].System != "liked" || playlists[0].Name != "" || playlists[1].ID != "7" || playlists[1].Description != "Example description" {
		t.Fatalf("playlists = %+v", playlists)
	}
	works, err := client.PlaylistWorks(context.Background(), "list-a", 100)
	if err != nil || len(works) != 1 || works[0].SourceID != code {
		t.Fatalf("playlist works = %+v, %v", works, err)
	}
}

func TestAccountClientNeverFollowsRedirects(t *testing.T) {
	var leaked atomic.Int32
	elsewhere := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		leaked.Add(1)
	}))
	defer elsewhere.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer server.Close()

	client := accountTestClient(t, server)
	if err := client.Login(context.Background(), "synthetic-user", "synthetic-password"); err == nil {
		t.Fatal("redirected login succeeded")
	}
	if _, err := client.WithToken("synthetic-token").Reviews(context.Background(), 10); err == nil {
		t.Fatal("redirected review request succeeded")
	}
	if leaked.Load() != 0 {
		t.Fatalf("credentials followed a redirect %d times", leaked.Load())
	}
}

func TestAccountClientRejectsOversizedAndNonJSONResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/review" {
			_, _ = w.Write([]byte(`{"works":["` + strings.Repeat("x", int(maxAccountResponseBytes)) + `"]}`))
			return
		}
		_, _ = w.Write([]byte(`<html>not an API</html>`))
	}))
	defer server.Close()

	client := accountTestClient(t, server).WithToken("synthetic-token")
	if _, err := client.Reviews(context.Background(), 10); !errors.Is(err, ErrAccountLimit) {
		t.Fatalf("oversized response error = %v", err)
	}
	if _, err := client.Playlists(context.Background()); !errors.Is(err, ErrAccountUnsupported) {
		t.Fatalf("HTML response error = %v", err)
	}
}

func TestAccountClientStopsWhenCancelled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, `{"works":[{"id":0}],"pagination":{"pageSize":1,"totalCount":5}}`)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := accountTestClient(t, server).Reviews(ctx, 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled error = %v", err)
	}
}
