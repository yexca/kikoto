package naturalorder

import (
	"bytes"
	"testing"
)

func TestCompareReadsNumbers(t *testing.T) {
	for _, pair := range [][2]string{
		{"Track2.mp3", "Track10.mp3"},
		{"a.lrc", "B.lrc"},
		{"第二話.mp3", "第十話.mp3"},
		{"第九話.mp3", "第二十一話.mp3"},
	} {
		if Compare(pair[0], pair[1]) >= 0 || Compare(pair[1], pair[0]) <= 0 {
			t.Errorf("%q does not come before %q", pair[0], pair[1])
		}
	}
}

// A stored key orders names as Compare does, so a database orders by it.
func TestKeyOrdersAsCompare(t *testing.T) {
	names := []string{"Track10.mp3", "track2.mp3", "第十話", "第二話", "Ａlbum", "album 3", "Album 20", "été", "Ete 2"}
	for _, left := range names {
		for _, right := range names {
			want := Compare(left, right)
			got := bytes.Compare(Key(left), Key(right))
			if want != 0 && got != want {
				t.Errorf("Key(%q) vs Key(%q) = %d, Compare = %d", left, right, got, want)
			}
		}
	}
	if !bytes.Equal(Key("Album"), Key("ALBUM")) {
		t.Error("names that read the same have different keys")
	}
}
