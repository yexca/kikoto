package httpapi

import (
	"fmt"
	"slices"
)

// Demo shows Rankings with two fixed synthetic lists. Every title and circle
// is an obvious sample, every code comes from the repository-reserved
// RJ00000000 sequence, and nothing is stored, refreshed, or linked.

type demoRankingList struct {
	list     rankingList
	current  []string
	previous []string
}

const (
	demoRankingPulledAt   = "2026-10-14 09:00:00"
	demoRankingPreviousAt = "2026-10-13 09:00:00"
)

var demoRankingLists = []demoRankingList{
	{
		list: rankingList{ID: 1, Provider: rankingProviderDLsite, Period: "day", ReleaseWindow: "30d", Depth: rankingDefaultDepth, Enabled: true, Position: 0, LastStatus: "succeeded", Unseen: true},
		current: []string{
			"RJ00000070", "RJ00000071", "RJ00000072", "RJ00000073", "RJ00000074", "RJ00000075",
			"RJ00000076", "RJ00000077", "RJ00000078", "RJ00000079",
		},
		previous: []string{
			"RJ00000071", "RJ00000070", "RJ00000073", "RJ00000080", "RJ00000072", "RJ00000075",
			"RJ00000081", "RJ00000077", "RJ00000074", "RJ00000079",
		},
	},
	{
		list: rankingList{ID: 2, Provider: rankingProviderDLsite, Period: "week", Depth: rankingDefaultDepth, Enabled: true, Position: 1, LastStatus: "succeeded"},
		current: []string{
			"RJ00000082", "RJ00000071", "RJ00000083", "RJ00000070", "RJ00000084", "RJ00000085",
			"RJ00000086", "RJ00000087",
		},
		previous: []string{
			"RJ00000082", "RJ00000083", "RJ00000071", "RJ00000070", "RJ00000084", "RJ00000085",
			"RJ00000086", "RJ00000087",
		},
	},
}

func demoRankingListView(item demoRankingList) rankingList {
	list := item.list
	pulledAt, changedAt := demoRankingPulledAt, demoRankingPulledAt
	list.LastPulledAt, list.LastChangedAt = &pulledAt, &changedAt
	return list
}

func demoRankingOverview() rankingOverview {
	lists := make([]rankingList, 0, len(demoRankingLists))
	for _, item := range demoRankingLists {
		lists = append(lists, demoRankingListView(item))
	}
	return rankingOverview{
		Lists:    lists,
		Schedule: rankingSchedule{Enabled: true, IntervalHours: rankingDefaultIntervalHours},
		Demo:     true,
	}
}

func demoRankingFallback(code string) rankingFallback {
	number := code[len(code)-2:]
	return rankingFallback{Code: code, Title: "Example Ranked Work " + number, Circle: fmt.Sprintf("Example Circle %c", number[1])}
}

// demoRankingPage compares a list's fixed current order with its fixed
// previous order; "previous" and "seen" read the same baseline.
func demoRankingPage(id int64, compare string) (rankingPage, bool) {
	index := slices.IndexFunc(demoRankingLists, func(item demoRankingList) bool { return item.list.ID == id })
	if index < 0 {
		return rankingPage{}, false
	}
	demo := demoRankingLists[index]
	latest := rankingSnapshotRef{ID: id * 10, PulledAt: demoRankingPulledAt}
	previous := rankingSnapshotRef{ID: id*10 - 1, PulledAt: demoRankingPreviousAt}
	kind := "previous"
	if compare == "" || compare == "seen" {
		kind = "seen"
	}
	page := rankingPage{
		List:      demoRankingListView(demo),
		Snapshot:  &latest,
		Baseline:  &rankingBaseline{rankingSnapshotRef: previous, Kind: kind},
		Items:     []rankingItem{},
		Dropped:   []rankingDroppedItem{},
		Snapshots: []rankingSnapshotRef{latest, previous},
		Demo:      true,
	}
	baseRanks := map[string]int{}
	for rank, code := range demo.previous {
		baseRanks[code] = rank + 1
	}
	current := map[string]bool{}
	for rank, code := range demo.current {
		current[code] = true
		entry := rankingEntryRecord{firstSeenAt: demoRankingPreviousAt, streakStartedAt: demoRankingPreviousAt, bestRank: rank + 1, appearances: 2}
		if _, found := baseRanks[code]; !found {
			entry = rankingEntryRecord{firstSeenAt: demoRankingPulledAt, streakStartedAt: demoRankingPulledAt, bestRank: rank + 1, appearances: 1}
		}
		item := rankingItem{
			Rank: rank + 1, Code: code, Change: rankingItemChange(rank+1, code, entry, page.Baseline, baseRanks),
			FirstSeenAt: entry.firstSeenAt, StreakStartedAt: entry.streakStartedAt, BestRank: entry.bestRank, Appearances: entry.appearances,
			Fallback: demoRankingFallback(code),
		}
		switch item.Change.Kind {
		case "new":
			page.Counts.New++
		case "up":
			page.Counts.Up++
		case "down":
			page.Counts.Down++
		}
		page.Counts.NotInLibrary++
		page.Items = append(page.Items, item)
	}
	for rank, code := range demo.previous {
		if !current[code] {
			page.Dropped = append(page.Dropped, rankingDroppedItem{Code: code, PreviousRank: rank + 1, Fallback: demoRankingFallback(code)})
		}
	}
	page.Counts.Dropped = len(page.Dropped)
	return page, true
}
