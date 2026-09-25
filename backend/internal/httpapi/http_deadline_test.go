package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const testFirstResponseBudget = 50 * time.Millisecond

func serveWithFirstResponseDeadline(t *testing.T, pattern string, handler http.HandlerFunc, exempt bool) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc(pattern, handler)
	exemptPatterns := map[string]bool{}
	if exempt {
		exemptPatterns[pattern] = true
	}
	response := httptest.NewRecorder()
	withFirstResponseDeadline(mux, mux, testFirstResponseBudget, exemptPatterns).
		ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/example", nil))
	return response
}

func TestFirstResponseDeadlineReleasesRequestWaitingForConnection(t *testing.T) {
	db := openMigratedTestDB(t)
	// Hold the only connection so the handler waits in the pool, as it would
	// behind requests that exhausted the production pool.
	held, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Close() }()

	response := serveWithFirstResponseDeadline(t, "GET /api/example", func(w http.ResponseWriter, r *http.Request) {
		var value int
		if err := db.QueryRowContext(r.Context(), "SELECT 1").Scan(&value); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"value": value})
	}, false)

	var body struct {
		Code      string `json:"code"`
		Retryable bool   `json:"retryable"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
	if response.Code != http.StatusServiceUnavailable || body.Code != "service_unavailable" || !body.Retryable {
		t.Fatalf("response = %d %s, want retryable 503 service_unavailable", response.Code, response.Body.String())
	}
}

func TestFirstResponseDeadlineDisarmsOnceResponseStarts(t *testing.T) {
	response := serveWithFirstResponseDeadline(t, "GET /api/example", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		time.Sleep(3 * testFirstResponseBudget)
		if err := r.Context().Err(); err != nil {
			t.Errorf("started response context error = %v, want live context", err)
		}
		_, _ = w.Write([]byte("complete"))
	}, false)
	if response.Code != http.StatusOK || response.Body.String() != "complete" {
		t.Fatalf("streamed response = %d %q, want 200 complete", response.Code, response.Body.String())
	}
}

func TestFirstResponseDeadlineSkipsExemptPattern(t *testing.T) {
	// Exemption matches the registered pattern, not the concrete request path.
	response := serveWithFirstResponseDeadline(t, "GET /api/{name}", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * testFirstResponseBudget)
		if err := r.Context().Err(); err != nil {
			t.Errorf("exempt route context error = %v, want live context", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}, true)
	if response.Code != http.StatusNoContent {
		t.Fatalf("exempt response = %d, want 204", response.Code)
	}
}
