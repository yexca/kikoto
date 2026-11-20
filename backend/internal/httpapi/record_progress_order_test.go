package httpapi

import (
	"testing"
	"time"
)

// A save ordered by a clock running far ahead never pins a file's progress:
// it is ordered by when the server receives it, as a save without an order is.
func TestRecordProgressOrderIsBoundedByTheServerClock(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		order, want int64
	}{
		{order: 0, want: now.UnixMilli()},
		{order: now.Add(-time.Hour).UnixMilli(), want: now.Add(-time.Hour).UnixMilli()},
		{order: now.Add(4 * time.Minute).UnixMilli(), want: now.Add(4 * time.Minute).UnixMilli()},
		{order: now.Add(24 * time.Hour).UnixMilli(), want: now.UnixMilli()},
	} {
		if got := recordProgressOrder(test.order, now); got != test.want {
			t.Errorf("recordProgressOrder(%d) = %d, want %d", test.order, got, test.want)
		}
	}
}
