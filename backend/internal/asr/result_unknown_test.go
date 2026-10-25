package asr

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestTranscriptionDistinguishesLostResponsesFromRefusedRequests(t *testing.T) {
	for _, outcome := range []string{"before_send", "rejected", "response_lost"} {
		t.Run(outcome, func(t *testing.T) {
			var uploads atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				uploads.Add(1)
				if outcome == "response_lost" {
					connection, _, err := w.(http.Hijacker).Hijack()
					if err == nil {
						_ = connection.Close()
					}
					return
				}
				http.Error(w, "Synthetic rejection", http.StatusUnprocessableEntity)
			}))
			t.Cleanup(upstream.Close)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if outcome == "before_send" {
				cancel()
			}
			client := Client{HTTP: upstream.Client(), Provider: Provider{PresetID: "custom-openai", BaseURL: upstream.URL}}
			_, err := client.Transcribe(ctx, "example-model", "ja", "", make([]byte, BytesPerSecond))
			if err == nil || errors.Is(err, ErrResultUnknown) != (outcome == "response_lost") {
				t.Fatalf("outcome=%s error=%v", outcome, err)
			}
			if outcome == "before_send" && uploads.Load() != 0 {
				t.Fatal("a cancelled request reached the service")
			}
			if outcome == "rejected" {
				var rejection UpstreamError
				if !errors.As(err, &rejection) || rejection.Status != http.StatusUnprocessableEntity {
					t.Fatalf("rejection=%v", err)
				}
			}
		})
	}
}
