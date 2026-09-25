package outbound

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// maxRetryAfterSeconds keeps the float-to-Duration conversion in range.
const maxRetryAfterSeconds = float64(math.MaxInt64 / int64(time.Second))

// RetryAfter parses a Retry-After header value as a positive delay relative to
// now. The value comes from a remote response and is untrusted: non-finite and
// non-positive values are ignored, and very large values saturate instead of
// overflowing. RetryAfter does not apply a policy maximum; callers must clamp
// the result to their own configured bound before waiting on it.
func RetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil {
		if math.IsNaN(seconds) || seconds <= 0 {
			return 0
		}
		if seconds >= maxRetryAfterSeconds {
			return time.Duration(math.MaxInt64)
		}
		return time.Duration(seconds * float64(time.Second))
	}
	if at, err := http.ParseTime(value); err == nil {
		if delay := at.Sub(now); delay > 0 {
			return delay
		}
	}
	return 0
}
