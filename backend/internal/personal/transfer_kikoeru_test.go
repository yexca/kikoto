package personal

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestKikoeruNumericCodeDecodesTypedIDs(t *testing.T) {
	// Explicit literals: the typed numeric encoding is the behavior under test.
	for id, want := range map[int64]string{
		0:                 "RJ000000",
		1_000_000_000_000: "BJ000000",
		2_000_000_000_000: "VJ000000",
		3_000_000_000_000: "CC000000",
	} {
		if code, ok := KikoeruNumericCode(id); !ok || code != want {
			t.Fatalf("KikoeruNumericCode(%d) = %q, %v; want %q", id, code, ok, want)
		}
	}
	for _, id := range []int64{-1, 4_000_000_000_000, 100_000_000} {
		if code, ok := KikoeruNumericCode(id); ok {
			t.Fatalf("KikoeruNumericCode(%d) = %q, want rejection", id, code)
		}
	}
}

func TestKikoeruFileImportAcceptsTypedNumericIDs(t *testing.T) {
	data := []byte(`{"works":[{"id":2000000000000,"progress":"listened"}],"pagination":{"currentPage":1}}`)
	b, err := ParseImport(ImportRequest{Format: "kikoeru", Data: data})
	if err != nil || len(b.Works) != 1 || b.Works[0].PrimaryCode != "VJ000000" {
		t.Fatalf("typed id import = %+v, %v", b, err)
	}
}

func TestKikoeruAccountBackupSkipsUnusableRowsAndMapsPlaylists(t *testing.T) {
	first := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	second := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	rating, outOfRange := 4, 9
	b, summary, err := KikoeruAccountBackup(
		[]KikoeruReview{
			{Code: strings.ToLower(first), Progress: "replay", Rating: &rating, ReviewText: "Example note"},
			{Code: first, Progress: "listened"},
			{Code: "not-a-code", Progress: "listened"},
			{Code: second, Progress: "future-state", Rating: &outOfRange},
		},
		[]KikoeruPlaylist{
			{System: "liked", Codes: []string{second, first, second, "not-a-code"}},
			{System: "marked"},
			{Name: "Example List", Description: "Example description", Codes: []string{first}},
			{Name: "Example List"},
		},
		KikoeruPlaylistNames{Liked: "Example Liked"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if summary != (KikoeruSummary{Works: 2, SkippedWorks: 2, Playlists: 3, SkippedPlaylistItems: 2}) {
		t.Fatalf("summary = %+v", summary)
	}
	if b.Works[0].PrimaryCode != first || b.Works[0].ListeningStatus != "relisten" || *b.Works[0].Rating != 4 || b.Works[0].Note != "Example note" {
		t.Fatalf("first work = %+v", b.Works[0])
	}
	if b.Works[1].ListeningStatus != "none" || b.Works[1].Rating != nil {
		t.Fatalf("unknown progress or rating kept: %+v", b.Works[1])
	}
	names := []string{b.Playlists[0].Name, b.Playlists[1].Name, b.Playlists[2].Name}
	if strings.Join(names, "|") != "Example Liked|Example List|Example List (2)" {
		t.Fatalf("playlist names = %v", names)
	}
	liked := b.Playlists[0].Items
	if len(liked) != 2 || liked[0].PrimaryCode != second || liked[1].PrimaryCode != first || liked[1].SortOrder != 1 {
		t.Fatalf("liked items = %+v", liked)
	}
}

func TestKikoeruAccountBackupBoundsTheImportBudget(t *testing.T) {
	reviews := make([]KikoeruReview, 0, 200)
	for index := range 200 {
		reviews = append(reviews, KikoeruReview{Code: testfixture.WorkCodeAt(index), ReviewText: strings.Repeat("文", maxKikoeruNoteRunes+10)})
	}
	if _, _, err := KikoeruAccountBackup(reviews, nil, KikoeruPlaylistNames{}); !errors.Is(err, ErrLimit) {
		t.Fatalf("oversized account error = %v", err)
	}
	b, _, err := KikoeruAccountBackup(reviews[:1], nil, KikoeruPlaylistNames{})
	if err != nil || len([]rune(b.Works[0].Note)) != maxKikoeruNoteRunes {
		t.Fatalf("note was not truncated: %d, %v", len(b.Works[0].Note), err)
	}
	encoded, _ := json.Marshal(b)
	if _, err := ParseImport(ImportRequest{Format: "kikoto", Data: encoded}); err != nil {
		t.Fatalf("converted backup does not round-trip: %v", err)
	}
}
