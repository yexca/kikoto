package llm

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// A failed translation request says whether it could have reached the
// provider: only a request whose headers left and whose answer was lost has
// an unknown result.
func TestTranslateReportsWhetherAFailedRequestLeft(t *testing.T) {
	var requests atomic.Int32
	answer := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		switch {
		case strings.HasPrefix(r.URL.Path, "/lost/"):
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = connection.Close()
			}
		case strings.HasPrefix(r.URL.Path, "/invalid/"):
			_, _ = w.Write([]byte(`{"choices":[]}`))
		}
	})
	server := httptest.NewServer(answer)
	defer server.Close()
	closed := httptest.NewServer(answer)
	closed.Close()
	translate := func(base string, input Text) error {
		client := Client{HTTP: server.Client(), Provider: Provider{PresetID: "custom-openai", BaseURL: base}}
		_, err := client.Translate(context.Background(), "example-model", "", "zh-cn", input)
		return err
	}

	title := Text{Title: "Example title"}
	// An oversized request is refused before it leaves.
	if err := translate(server.URL, Text{Description: strings.Repeat("a", requestLimit)}); !errors.Is(err, ErrRequestTooLarge) || requests.Load() != 0 {
		t.Fatalf("too large = %v, requests = %d", err, requests.Load())
	}
	// A provider that cannot be reached never received the request.
	if err := translate(closed.URL, title); err == nil || errors.Is(err, ErrResultUnknown) || errors.Is(err, ErrInvalidResult) {
		t.Fatalf("unreachable = %v", err)
	}
	// A request that left and lost its answer may have been charged.
	if err := translate(server.URL+"/lost", title); !errors.Is(err, ErrResultUnknown) {
		t.Fatalf("lost answer = %v", err)
	}
	// An answer that is not a translation is known and unusable.
	if err := translate(server.URL+"/invalid", title); !errors.Is(err, ErrInvalidResult) || errors.Is(err, ErrResultUnknown) {
		t.Fatalf("invalid answer = %v", err)
	}
}
