package library

import "testing"

func TestValidateRecommendationConfigProtectsDiscoveryMix(t *testing.T) {
	if err := ValidateRecommendationConfig(DefaultRecommendationConfig()); err != nil {
		t.Fatalf("default recommendation config is invalid: %v", err)
	}

	withoutUnmarked := DefaultRecommendationConfig()
	withoutUnmarked.UnmarkedSlots = 0
	if err := ValidateRecommendationConfig(withoutUnmarked); err == nil {
		t.Fatal("recommendation config without Unmarked slots was accepted")
	}

	oversized := DefaultRecommendationConfig()
	oversized.UnmarkedSlots = 100
	if err := ValidateRecommendationConfig(oversized); err == nil {
		t.Fatal("recommendation config with more than 100 total slots was accepted")
	}
}
