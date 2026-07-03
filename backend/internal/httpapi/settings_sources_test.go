package httpapi

import "testing"

func TestSelectedRemotePathMatches(t *testing.T) {
	tests := []struct {
		name     string
		selected []string
		filePath string
		want     bool
	}{
		{
			name:     "exact file",
			selected: []string{"honhen/mp3/01.mp3"},
			filePath: "honhen/mp3/01.mp3",
			want:     true,
		},
		{
			name:     "directory prefix",
			selected: []string{"honhen/mp3"},
			filePath: "honhen/mp3/01.mp3",
			want:     true,
		},
		{
			name:     "sibling directory is not selected",
			selected: []string{"honhen/mp3"},
			filePath: "honhen/wav/01.wav",
			want:     false,
		},
		{
			name:     "same basename in other directory is not selected",
			selected: []string{"honhen/mp3/01.mp3"},
			filePath: "bonus/mp3/01.mp3",
			want:     false,
		},
		{
			name:     "cleans path traversal",
			selected: []string{"honhen/../mp3"},
			filePath: "mp3/01.mp3",
			want:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			selected := normalizeSelectedRemotePaths(test.selected)
			got := selectedRemotePathMatches(selected, test.filePath)
			if got != test.want {
				t.Fatalf("selectedRemotePathMatches(%v, %q) = %v, want %v", test.selected, test.filePath, got, test.want)
			}
		})
	}
}
