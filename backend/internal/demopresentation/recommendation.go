// Package demopresentation supplies deterministic, synthetic Demo display data.
package demopresentation

import (
	"crypto/sha256"
	"encoding/binary"
	"strings"
)

const RecommendationVersion = "demo-random-v1"

// RecommendationScore is a simulated 0–100 score for a unified work identity.
// A missing session uses a stable default. Sorting seeds and preference data
// do not participate, so reshuffling only changes the order of the cards.
func RecommendationScore(sessionID, primaryCode string) int {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		sessionID = "default"
	}
	primaryCode = strings.ToUpper(strings.TrimSpace(primaryCode))
	digest := sha256.Sum256([]byte(RecommendationVersion + "\x00" + sessionID + "\x00" + primaryCode))
	return int(binary.BigEndian.Uint64(digest[:8]) % 101)
}
