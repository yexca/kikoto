package outbound

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type recordingRoute struct {
	name  string
	err   error
	calls *[]string
}

func (route recordingRoute) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.Body != nil {
		body, _ := io.ReadAll(request.Body)
		_ = request.Body.Close()
		*route.calls = append(*route.calls, route.name+":"+string(body))
	} else {
		*route.calls = append(*route.calls, route.name)
	}
	if route.err != nil {
		return nil, route.err
	}
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: request}, nil
}

func TestFailoverTransportTriesRoutesInPriorityOrder(t *testing.T) {
	var calls []string
	now := time.Unix(1_700_000_000, 0)
	transport := NewFailoverTransport(
		recordingRoute{name: "first", err: errors.New("proxy unreachable"), calls: &calls},
		recordingRoute{name: "second", calls: &calls},
		recordingRoute{name: "third", calls: &calls},
	).(*FailoverTransport)
	transport.now = func() time.Time { return now }

	request, _ := http.NewRequest(http.MethodGet, "http://metadata.test/work", nil)
	response, err := transport.RoundTrip(request)
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("failover response = %v, %v", response, err)
	}
	if strings.Join(calls, ",") != "first,second" {
		t.Fatalf("routes tried = %v, want first then second", calls)
	}

	calls = nil
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "second" {
		t.Fatalf("routes tried during cooldown = %v, want the failed route skipped", calls)
	}

	now = now.Add(failoverCooldown + time.Second)
	calls = nil
	if _, err := transport.RoundTrip(request); err != nil || strings.Join(calls, ",") != "first,second" {
		t.Fatalf("routes tried after cooldown = %v (error %v), want the first route retried first", calls, err)
	}
}

func TestFailoverTransportStopsOnPolicyViolationAndCancellation(t *testing.T) {
	var calls []string
	transport := NewFailoverTransport(
		recordingRoute{name: "first", err: violation("destination rejected"), calls: &calls},
		recordingRoute{name: "second", calls: &calls},
	)
	request, _ := http.NewRequest(http.MethodGet, "http://metadata.test/work", nil)
	if _, err := transport.RoundTrip(request); !errors.Is(err, ErrPolicyViolation) || len(calls) != 1 {
		t.Fatalf("policy violation error = %v after routes %v, want no further route", err, calls)
	}

	calls = nil
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	transport = NewFailoverTransport(
		recordingRoute{name: "first", err: context.Canceled, calls: &calls},
		recordingRoute{name: "second", calls: &calls},
	)
	request, _ = http.NewRequestWithContext(ctx, http.MethodGet, "http://metadata.test/work", nil)
	if _, err := transport.RoundTrip(request); err == nil || len(calls) != 1 {
		t.Fatalf("canceled request error = %v after routes %v, want no further route", err, calls)
	}
}

func TestFailoverTransportReplaysOnlyReplayableBodies(t *testing.T) {
	var calls []string
	transport := NewFailoverTransport(
		recordingRoute{name: "first", err: errors.New("proxy unreachable"), calls: &calls},
		recordingRoute{name: "second", calls: &calls},
	)
	request, _ := http.NewRequest(http.MethodPost, "http://metadata.test/work", strings.NewReader("payload"))
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "first:payload,second:payload" {
		t.Fatalf("replayed bodies = %v", calls)
	}

	calls = nil
	transport = NewFailoverTransport(
		recordingRoute{name: "first", err: errors.New("proxy unreachable"), calls: &calls},
		recordingRoute{name: "second", calls: &calls},
	)
	request, _ = http.NewRequest(http.MethodPost, "http://metadata.test/work", io.NopCloser(strings.NewReader("stream")))
	request.GetBody = nil
	if _, err := transport.RoundTrip(request); err == nil || strings.Join(calls, ",") != "first:stream" {
		t.Fatalf("non-replayable body error = %v after routes %v, want no replay", err, calls)
	}
}

func TestFailoverTransportTriesFallbackOnlyAfterEveryRoute(t *testing.T) {
	var calls []string
	now := time.Unix(1_700_000_000, 0)
	transport := NewFailoverTransportWithFallback(
		recordingRoute{name: "direct", calls: &calls},
		recordingRoute{name: "first", err: errors.New("proxy unreachable"), calls: &calls},
		recordingRoute{name: "second", err: errors.New("proxy unreachable"), calls: &calls},
	).(*FailoverTransport)
	transport.now = func() time.Time { return now }
	request, _ := http.NewRequest(http.MethodGet, "http://metadata.test/work", nil)
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "first,second,direct" {
		t.Fatalf("routes tried = %v, want the fallback last", calls)
	}

	// While both proxies cool down they are still tried before the fallback.
	calls = nil
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "first,second,direct" {
		t.Fatalf("routes tried during cooldown = %v, want the fallback last", calls)
	}

	calls = nil
	transport = NewFailoverTransportWithFallback(
		recordingRoute{name: "direct", calls: &calls},
		recordingRoute{name: "first", err: violation("destination rejected"), calls: &calls},
	).(*FailoverTransport)
	if _, err := transport.RoundTrip(request); !errors.Is(err, ErrPolicyViolation) || len(calls) != 1 {
		t.Fatalf("policy violation error = %v after routes %v, want no fallback", err, calls)
	}
}
