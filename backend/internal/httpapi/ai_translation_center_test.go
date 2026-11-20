package httpapi

import "testing"

func TestTranslationLanguageStageFromItemStates(t *testing.T) {
	cases := []struct {
		name   string
		states map[string]int
		stage  string
		done   int
		count  int
	}{
		{"a request is out", map[string]int{"requesting": 1, "queued": 2}, "translating", 0, 0},
		{"some items settled while others queue", map[string]int{"ready": 2, "queued": 2}, "translating", 2, 2},
		{"every item waits in the queue", map[string]int{"queued": 3}, "queued", 0, 3},
		{"translated items wait for review", map[string]int{"ready": 2, "accepted": 1}, "review", 3, 2},
		{"stopped items remain once nothing waits for review", map[string]int{"accepted": 1, "failed": 1}, "stopped", 2, 1},
		{"every item is accepted", map[string]int{"accepted": 2}, "done", 2, 2},
	}
	for _, tc := range cases {
		stage, done, count := translationLanguageStage(tc.states)
		if stage != tc.stage || done != tc.done || count != tc.count {
			t.Errorf("%s: got %s %d %d, want %s %d %d", tc.name, stage, done, count, tc.stage, tc.done, tc.count)
		}
	}
}
