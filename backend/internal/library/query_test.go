package library

import "testing"

func TestRecommendationSlotOffsetsKeepIntentFirstAndUnmarkedPrimary(t *testing.T) {
	cycleSize, offsets := recommendationSlotOffsets(DefaultRecommendationConfig())
	if cycleSize != 24 {
		t.Fatalf("recommendation cycle size = %d, want 24", cycleSize)
	}
	wantCounts := map[string]int{
		"none": 12, "listening": 4, "want_to_listen": 4, "relisten": 2, "finished": 2, "paused": 0,
	}
	for status, want := range wantCounts {
		if got := len(offsets[status]); got != want {
			t.Fatalf("%s slots = %d, want %d: %#v", status, got, want, offsets[status])
		}
	}
	if offsets["listening"][0] != 1 || offsets["want_to_listen"][0] != 2 {
		t.Fatalf("leading slots = listening %v, want %v; want positions 1 and 2", offsets["listening"], offsets["want_to_listen"])
	}
	if offsets["relisten"][0] < 5 || offsets["finished"][0] < 9 {
		t.Fatalf("secondary lanes appear too early: relisten %v, finished %v", offsets["relisten"], offsets["finished"])
	}
	if len(offsets["paused"]) != 0 {
		t.Fatalf("default recommendation cycle schedules shelved positions: %v", offsets["paused"])
	}
}
