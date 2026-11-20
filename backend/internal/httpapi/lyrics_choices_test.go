package httpapi

import (
	"fmt"
	"reflect"
	"testing"
)

const lyricsChoicesRoot = "Library/RJ00000000/"

func lyricsChoiceItem(id int64, kind string, relative string, assignments ...mediaLyricsAssignmentDetail) mediaItemDetail {
	return mediaItemDetail{
		ID: id, Kind: kind, LyricsAssignments: assignments,
		Locations: []fileLocationDetail{{
			ID: id + 100, LocationType: "local", Path: lyricsChoicesRoot + relative, Availability: "available",
		}},
	}
}

// describeLyricsChoices lists choices as "item:reason" or "item:reason:language".
func describeLyricsChoices(choices []mediaLyricsChoice) []string {
	result := []string{}
	for _, choice := range choices {
		value := fmt.Sprintf("%d:%s", choice.LyricsMediaItemID, choice.Reason)
		if choice.Language != "" {
			value += ":" + choice.Language
		}
		result = append(result, value)
	}
	return result
}

func TestWorkMediaLyricsChoicesLeadWithAssignments(t *testing.T) {
	items := []mediaItemDetail{
		lyricsChoiceItem(1, "audio", "mp3/01 First.mp3",
			mediaLyricsAssignmentDetail{Language: "zh-cn", LyricsMediaItemID: 12},
			mediaLyricsAssignmentDetail{Language: "", LyricsMediaItemID: 12},
			mediaLyricsAssignmentDetail{Language: "en-us", LyricsMediaItemID: 13},
			// A file that is no longer available is not a choice.
			mediaLyricsAssignmentDetail{Language: "ja-jp", LyricsMediaItemID: 99},
		),
		lyricsChoiceItem(2, "audio", "mp3/02 Second.mp3"),
		lyricsChoiceItem(11, "text", "mp3/01 First.mp3.vtt"),
		lyricsChoiceItem(12, "text", "lyrics_kikoto/zh-hans/Track1.vtt"),
		lyricsChoiceItem(13, "text", "lyrics_kikoto/en/Track1.vtt"),
		lyricsChoiceItem(14, "text", "mp3/notes.txt"),
	}
	attachMediaLyricsChoices(items)

	first := items[0].Locations[0]
	// One file assigned in two languages is one choice, under its first language.
	want := []string{"12:assigned:zh-cn", "13:assigned:en-us", "11:exact_sidecar"}
	if got := describeLyricsChoices(first.LyricsChoices); !reflect.DeepEqual(got, want) {
		t.Fatalf("choices = %v, want %v", got, want)
	}
	if first.LyricsChoices[0].LocationID != 112 {
		t.Fatalf("an assigned file is read from %d, want its local location", first.LyricsChoices[0].LocationID)
	}
	if first.LyricsMatchMediaItemID == nil || *first.LyricsMatchMediaItemID != 11 {
		t.Fatalf("name match = %v, want 11", first.LyricsMatchMediaItemID)
	}
	second := items[1].Locations[0]
	if second.LyricsChoices != nil || second.LyricsMatchMediaItemID != nil {
		t.Fatalf("a track without lyrics has choices %v", describeLyricsChoices(second.LyricsChoices))
	}
	if items[2].Locations[0].LyricsChoices != nil {
		t.Fatal("a lyrics file has lyrics choices")
	}
}

func TestWorkMediaLyricsNameMatchSurvivesItsAssignment(t *testing.T) {
	items := []mediaItemDetail{
		lyricsChoiceItem(1, "audio", "01 First.mp3", mediaLyricsAssignmentDetail{Language: "", LyricsMediaItemID: 11}),
		lyricsChoiceItem(11, "text", "01 First.lrc"),
	}
	attachMediaLyricsChoices(items)
	location := items[0].Locations[0]
	if got := describeLyricsChoices(location.LyricsChoices); !reflect.DeepEqual(got, []string{"11:assigned"}) {
		t.Fatalf("choices = %v", got)
	}
	// The manager shows the name match a cleared assignment falls back to.
	if location.LyricsMatchMediaItemID == nil || *location.LyricsMatchMediaItemID != 11 {
		t.Fatalf("name match = %v, want 11", location.LyricsMatchMediaItemID)
	}
}

func TestRemoteTrackLyricsChoicesNameFilesOfTheSameTree(t *testing.T) {
	tracks := []remoteTrackDetail{
		{Type: "folder", Title: "Disc 1", Children: []remoteTrackDetail{
			{Type: "audio", Title: "01.wma"},
			{Type: "text", Title: "01.lrc"},
			{Type: "text", Title: "readme.txt"},
		}},
		{Type: "text", Title: "01.vtt"},
		{Type: "image", Title: "cover.jpg"},
	}
	attachRemoteLyricsChoices(tracks)
	got := []string{}
	for _, choice := range tracks[0].Children[0].LyricsChoices {
		got = append(got, choice.Path+":"+choice.Reason)
	}
	want := []string{"Disc 1/01.lrc:same_stem", "01.vtt:same_stem"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("choices = %v, want %v", got, want)
	}
	if tracks[0].Children[1].LyricsChoices != nil || tracks[2].LyricsChoices != nil {
		t.Fatal("a file that is not a track has lyrics choices")
	}
}

func lyricsEditTestItem(key string, relative string, language string, action string) lyricsEditItem {
	item := lyricsEditItem{Language: language}
	item.ItemKey, item.Path, item.Action = key+relative, relative, action
	return item
}

func TestLyricsEditPairsNamesFirstThenTrackOrder(t *testing.T) {
	audio := []lyricsEditAudio{
		newLyricsEditAudio(1, "mp3/Track1.Original opening.mp3"),
		newLyricsEditAudio(2, "mp3/Track2.Original ending.mp3"),
		newLyricsEditAudio(3, "mp3/Bonus talk.mp3"),
	}
	const remote = "remote:3:RJ00000001:"
	items := []lyricsEditItem{
		lyricsEditTestItem(remote, "mp3/Track1.Translated opening.mp3.vtt", "zh-cn", "cache_download"),
		lyricsEditTestItem(remote, "mp3/Track2.Translated ending.mp3.vtt", "zh-cn", "cache_download"),
		lyricsEditTestItem(remote, "mp3/Track3.Translated bonus.mp3.vtt", "zh-cn", "cache_download"),
		lyricsEditTestItem(remote, "extra/Bonus talk.lrc", "zh-cn", "cache_download"),
	}
	got := map[int64]string{}
	for _, assignment := range pairLyricsEditFiles(audio, items) {
		got[assignment.AudioMediaItemID] = items[assignment.item].Path
	}
	want := map[int64]string{
		1: "mp3/Track1.Translated opening.mp3.vtt",
		2: "mp3/Track2.Translated ending.mp3.vtt",
		3: "extra/Bonus talk.lrc",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pairs = %v, want %v", got, want)
	}
}

func TestLyricsEditPairingKeepsATracksLyricsAndSkipsLeftOutFiles(t *testing.T) {
	audio := []lyricsEditAudio{
		newLyricsEditAudio(1, "mp3/01 Opening.mp3", "zh-cn"),
		newLyricsEditAudio(2, "mp3/02 Ending.mp3"),
	}
	const remote = "remote:3:RJ00000001:"
	items := []lyricsEditItem{
		lyricsEditTestItem("folder:", "mp3/01 Opening.mp3.vtt", "ja-jp", "copy_local"),
		lyricsEditTestItem(remote, "sub/01 Opening.vtt", "zh-cn", "cache_download"),
		lyricsEditTestItem(remote, "sub/02 Ending.vtt", "zh-cn", "cache_download"),
	}
	describe := func(assignments []lyricsEditPlannedAssignment) []string {
		result := []string{}
		for _, assignment := range assignments {
			result = append(result, fmt.Sprintf("%d=%s", assignment.AudioMediaItemID, assignment.ItemKey))
		}
		return result
	}
	// The first track already has Simplified Chinese lyrics.
	want := []string{"1=folder:mp3/01 Opening.mp3.vtt", "2=" + remote + "sub/02 Ending.vtt"}
	if got := describe(pairLyricsEditFiles(audio, items)); !reflect.DeepEqual(got, want) {
		t.Fatalf("pairs = %v, want %v", got, want)
	}
	items[2].Action = "exclude"
	if got := describe(pairLyricsEditFiles(audio, items)); !reflect.DeepEqual(got, want[:1]) {
		t.Fatalf("pairs with a left-out file = %v, want %v", got, want[:1])
	}
}
