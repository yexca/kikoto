package outbound

import (
	"math"
	"net/http"
	"testing"
	"time"
)

func TestRetryAfterParsesUntrustedValuesWithoutOverflow(t *testing.T) {
	now := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	tests := []struct {
		value string
		want  time.Duration
	}{
		{"", 0},
		{"soon", 0},
		{"0", 0},
		{"-30", 0},
		{"NaN", 0},
		{"-Inf", 0},
		{"120", 2 * time.Minute},
		{" 1.5 ", 1500 * time.Millisecond},
		{"86400", 24 * time.Hour},
		{"Inf", time.Duration(math.MaxInt64)},
		{"1e300", time.Duration(math.MaxInt64)},
		{now.Add(90 * time.Second).Format(http.TimeFormat), 90 * time.Second},
		{now.Add(-time.Minute).Format(http.TimeFormat), 0},
	}
	for _, test := range tests {
		t.Run(test.value, func(t *testing.T) {
			if got := RetryAfter(test.value, now); got != test.want {
				t.Fatalf("RetryAfter(%q) = %v, want %v", test.value, got, test.want)
			}
		})
	}
}
