package contentpolicy

import "testing"

func TestIsAllAges(t *testing.T) {
	for _, value := range []string{"general", "All Ages", "全年齢", "全年龄"} {
		if !IsAllAges(value) {
			t.Fatalf("IsAllAges(%q) = false", value)
		}
	}
	for _, value := range []string{"", "adult", "r15"} {
		if IsAllAges(value) {
			t.Fatalf("IsAllAges(%q) = true", value)
		}
	}
}
