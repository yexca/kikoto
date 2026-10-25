package httpapi

import (
	"fmt"
	"slices"
	"strconv"
	"time"
)

// Demo shows Rankings with fixed synthetic lists and a short history. Every
// title and circle is an obvious sample, every code comes from the
// repository-reserved RJ00000000 sequence, and nothing is stored, refreshed,
// or linked. Each order of a list shows the sample history in its own
// arrangement.

type demoRankingSnapshot struct {
	pulledAt, confirmedUntil string
	codes                    []string
}

type demoRankingList struct {
	list rankingList
	// snapshots are the default order's, oldest first.
	snapshots []demoRankingSnapshot
}

// demoRankingYear is the annual ranking year the samples treat as current.
const demoRankingYear = 2026

var demoRankingLists = []demoRankingList{
	{
		list: rankingList{ID: 1, Provider: rankingProviderDLsite, Period: "day", Depth: rankingDefaultDepth, Enabled: true, AutoRefresh: true, RefreshIntervalMinutes: 60, LastStatus: "succeeded"},
		snapshots: []demoRankingSnapshot{
			{"2026-10-12 09:00:00", "2026-10-12 21:00:00", demoRankingCodes(72, 70, 71, 73, 80, 75, 74, 81, 77, 79)},
			{"2026-10-13 09:00:00", "2026-10-13 18:00:00", demoRankingCodes(71, 70, 73, 80, 72, 75, 81, 77, 74, 79)},
			{"2026-10-14 09:00:00", "2026-10-14 12:00:00", demoRankingCodes(70, 71, 72, 73, 74, 75, 76, 77, 78, 79)},
		},
	},
	{
		list: rankingList{ID: 2, Provider: rankingProviderDLsite, Period: "week", Depth: rankingDefaultDepth, Enabled: true, AutoRefresh: true, RefreshIntervalMinutes: 360, LastStatus: "succeeded"},
		snapshots: []demoRankingSnapshot{
			{"2026-10-13 09:00:00", "2026-10-13 21:00:00", demoRankingCodes(82, 83, 71, 70, 84, 85, 86, 87)},
			{"2026-10-14 09:00:00", "2026-10-14 12:00:00", demoRankingCodes(82, 71, 83, 70, 84, 85, 86, 87)},
		},
	},
	{
		list: rankingList{ID: 3, Provider: rankingProviderDLsite, Period: "year", Year: demoRankingYear, Depth: rankingDefaultDepth, Enabled: true, AutoRefresh: true, RefreshIntervalMinutes: 7 * 24 * 60, FollowCurrentYear: true, LastStatus: "succeeded"},
		snapshots: []demoRankingSnapshot{
			{"2026-10-07 09:00:00", "2026-10-07 09:00:00", demoRankingCodes(90, 91, 92, 93, 94, 95)},
			{"2026-10-14 09:00:00", "2026-10-14 09:00:00", demoRankingCodes(90, 92, 91, 93, 95, 94)},
		},
	},
	{
		list: rankingList{ID: 4, Provider: rankingProviderDLsite, Period: "year", Year: demoRankingYear - 1, Depth: rankingDefaultDepth, Enabled: true, RefreshIntervalMinutes: 7 * 24 * 60, LastStatus: "succeeded"},
		snapshots: []demoRankingSnapshot{
			{"2026-01-03 09:00:00", "2026-01-03 09:00:00", demoRankingCodes(96, 97, 98, 99, 90, 91)},
		},
	},
	{
		list: rankingList{ID: 5, Provider: rankingProviderDLsite, Period: "total", Depth: rankingDefaultDepth, Enabled: true, AutoRefresh: true, RefreshIntervalMinutes: 7 * 24 * 60, LastStatus: "succeeded"},
		snapshots: []demoRankingSnapshot{
			{"2026-10-07 09:00:00", "2026-10-07 09:00:00", demoRankingCodes(60, 61, 62, 63, 64, 65, 66, 67)},
			{"2026-10-14 09:00:00", "2026-10-14 09:00:00", demoRankingCodes(60, 62, 61, 63, 64, 65, 67, 66)},
		},
	},
}

func demoRankingCodes(numbers ...int) []string {
	codes := make([]string, 0, len(numbers))
	for _, number := range numbers {
		codes = append(codes, fmt.Sprintf("RJ%08d", number))
	}
	return codes
}

// demoRankingVariantID numbers the orders of a sample list after the list.
func demoRankingVariantID(listID int64, orderIndex int) int64 {
	return listID*10 + int64(orderIndex) + 1
}

// demoRankingVariantSnapshots arranges the sample history for an order: each
// further order starts its ranking a little further down the default one.
func demoRankingVariantSnapshots(demo demoRankingList, orderIndex int) []demoRankingSnapshot {
	if orderIndex == 0 {
		return demo.snapshots
	}
	snapshots := make([]demoRankingSnapshot, 0, len(demo.snapshots))
	for _, snapshot := range demo.snapshots {
		shift := (2 * orderIndex) % len(snapshot.codes)
		codes := append(slices.Clone(snapshot.codes[shift:]), snapshot.codes[:shift]...)
		snapshots = append(snapshots, demoRankingSnapshot{pulledAt: snapshot.pulledAt, confirmedUntil: snapshot.confirmedUntil, codes: codes})
	}
	return snapshots
}

func demoRankingSnapshotRef(variantID int64, index int, snapshot demoRankingSnapshot) rankingSnapshotRef {
	return rankingSnapshotRef{ID: variantID*100 + int64(index) + 1, PulledAt: snapshot.pulledAt, ConfirmedUntil: snapshot.confirmedUntil}
}

func demoRankingListView(item demoRankingList) rankingList {
	list := item.list
	latest := item.snapshots[len(item.snapshots)-1]
	pulledAt, changedAt := latest.confirmedUntil, latest.pulledAt
	list.LastPulledAt = &pulledAt
	list.SourceAvailable = true
	if list.Period == "year" && list.Year < demoRankingYear {
		finalAt := latest.pulledAt
		list.FinalAt = &finalAt
	}
	orders := rankingOrdersFor(list.Provider, list.Period)
	list.Variants = make([]rankingVariant, 0, len(orders))
	for index, order := range orders {
		list.Variants = append(list.Variants, rankingVariant{
			ID: demoRankingVariantID(list.ID, index), ReleaseWindow: order.ReleaseWindow, Sort: order.Sort,
			LastPulledAt: &pulledAt, LastChangedAt: &changedAt, LastStatus: "succeeded",
			// The newest sample of the 24-hour default order is unread.
			Unseen: list.ID == 1 && index == 0,
		})
	}
	return list
}

func demoRankingOverview() rankingOverview {
	lists := make([]rankingList, 0, len(demoRankingLists))
	for _, item := range demoRankingLists {
		lists = append(lists, demoRankingListView(item))
	}
	return rankingOverview{
		Lists:       lists,
		Workflows:   []rankingWorkflowState{{Code: dlsiteRankingWorkflowCode}, {Code: remoteRankingWorkflowCode}},
		Retention:   rankingRetention{FullDays: rankingDefaultFullRetentionDays, DailyDays: rankingDefaultDailyRetentionDays},
		CurrentYear: demoRankingYear,
		Demo:        true,
	}
}

func demoRankingFallback(code string) rankingFallback {
	number := code[len(code)-2:]
	return rankingFallback{Code: code, Title: "Example Ranked Work " + number, Circle: fmt.Sprintf("Example Circle %c", number[1])}
}

// findDemoRankingVariant returns a sample list with the history of one of its
// orders, or errRankingOrderUnknown when the list is not pulled in it.
func findDemoRankingVariant(id int64, order rankingOrder) (rankingList, rankingVariant, []demoRankingSnapshot, bool, error) {
	index := slices.IndexFunc(demoRankingLists, func(item demoRankingList) bool { return item.list.ID == id })
	if index < 0 {
		return rankingList{}, rankingVariant{}, nil, false, nil
	}
	demo := demoRankingLists[index]
	list := demoRankingListView(demo)
	variant, err := list.variantFor(order)
	if err != nil {
		return list, variant, nil, true, err
	}
	orderIndex := int(variant.ID - demoRankingVariantID(id, 0))
	return list, variant, demoRankingVariantSnapshots(demo, orderIndex), true, nil
}

// demoRankingSnapshotAt is the index of the sample snapshot in effect at a
// time, or -1 before the first; a nil time reads the latest.
func demoRankingSnapshotAt(snapshots []demoRankingSnapshot, at *time.Time) int {
	if at == nil {
		return len(snapshots) - 1
	}
	shown := -1
	for index, snapshot := range snapshots {
		if snapshot.pulledAt <= formatWorkflowTimestamp(*at) {
			shown = index
		}
	}
	return shown
}

// demoRankingPage builds a page from the sample history with the same rules
// as a stored list. "seen" reads the previous snapshot.
func demoRankingPage(id int64, request rankingPageRequest) (rankingPage, bool, error) {
	list, variant, snapshots, found, err := findDemoRankingVariant(id, request.order)
	if !found || err != nil {
		return rankingPage{}, found, err
	}
	first := snapshots[0].pulledAt
	page := rankingPage{
		List: list, Variant: variant, Items: []rankingItem{}, Dropped: []rankingDroppedItem{},
		History: rankingHistoryBounds{FirstPulledAt: &first, FullFrom: "2026-09-14 09:00:00"}, Demo: true,
	}
	shown := demoRankingSnapshotAt(snapshots, request.at)
	var shownRef *rankingSnapshotRef
	if shown >= 0 {
		ref := demoRankingSnapshotRef(variant.ID, shown, snapshots[shown])
		shownRef = &ref
	}
	if request.at != nil {
		at := formatWorkflowTimestamp(*request.at)
		page.At = &at
		page.Coverage = rankingCoverageAt(shownRef, *request.at)
	}
	if shownRef == nil {
		next := demoRankingSnapshotRef(variant.ID, 0, snapshots[0])
		page.NextSnapshot = &next
		return page, true, nil
	}
	page.Snapshot = shownRef
	if shown > 0 {
		previous := demoRankingSnapshotRef(variant.ID, shown-1, snapshots[shown-1])
		page.PreviousSnapshot = &previous
	}
	if shown < len(snapshots)-1 {
		next := demoRankingSnapshotRef(variant.ID, shown+1, snapshots[shown+1])
		page.NextSnapshot = &next
	}
	var baseline int
	kind := "previous"
	switch {
	case request.compare == "" || request.compare == "seen" || request.compare == "previous":
		baseline = shown - 1
		if request.at == nil && request.compare != "previous" {
			kind = "seen"
		}
	case rankingSnapshotIDPattern.MatchString(request.compare):
		snapshotID, _ := strconv.ParseInt(request.compare, 10, 64)
		baseline, kind = int(snapshotID-variant.ID*100-1), "snapshot"
		if baseline < 0 || baseline >= len(snapshots) {
			return rankingPage{}, true, errRankingSnapshotNotFound
		}
	default:
		at, err := parseRankingTime(request.compare)
		if err != nil {
			return rankingPage{}, true, errRankingSnapshotNotFound
		}
		baseline, kind = demoRankingSnapshotAt(snapshots, &at), "snapshot"
		if baseline < 0 {
			return rankingPage{}, true, errRankingSnapshotNotFound
		}
	}
	baseCodes := []string{}
	if baseline >= 0 {
		page.Baseline = &rankingBaseline{rankingSnapshotRef: demoRankingSnapshotRef(variant.ID, baseline, snapshots[baseline]), Kind: kind}
		baseCodes = snapshots[baseline].codes
	}
	fillRankingPageItems(&page, snapshots[shown].codes, baseCodes, demoRankingEntries(snapshots))
	for index := range page.Items {
		page.Items[index].Fallback = demoRankingFallback(page.Items[index].Code)
	}
	for index := range page.Dropped {
		page.Dropped[index].Fallback = demoRankingFallback(page.Dropped[index].Code)
	}
	page.Counts.NotInLibrary = len(page.Items)
	return page, true, nil
}

// demoRankingEntries derives each sample code's statistics from the sample
// history, as a pull would.
func demoRankingEntries(snapshots []demoRankingSnapshot) map[string]rankingEntryRecord {
	entries := map[string]rankingEntryRecord{}
	var previous map[string]bool
	for _, snapshot := range snapshots {
		current := map[string]bool{}
		for index, code := range snapshot.codes {
			current[code] = true
			entry, known := entries[code]
			switch {
			case !known:
				entry = rankingEntryRecord{firstSeenAt: snapshot.pulledAt, streakStartedAt: snapshot.pulledAt, bestRank: index + 1}
			case !previous[code]:
				entry.streakStartedAt = snapshot.pulledAt
			}
			entry.bestRank = min(entry.bestRank, index+1)
			entry.appearances++
			entries[code] = entry
		}
		previous = current
	}
	return entries
}

func demoRankingTimeline(id int64, request rankingTimelineRequest) (rankingTimeline, bool, error) {
	_, variant, snapshots, found, err := findDemoRankingVariant(id, request.order)
	if !found || err != nil {
		return rankingTimeline{}, found, err
	}
	first, last := snapshots[0].pulledAt, snapshots[len(snapshots)-1].pulledAt
	timeline := rankingTimeline{Snapshots: []rankingSnapshotRef{}, FirstPulledAt: &first, LastPulledAt: &last, Demo: true}
	for index, snapshot := range snapshots {
		ref := demoRankingSnapshotRef(variant.ID, index, snapshot)
		if (request.from != nil && snapshot.pulledAt < formatWorkflowTimestamp(*request.from)) ||
			(request.to != nil && snapshot.pulledAt >= formatWorkflowTimestamp(*request.to)) || ref.ID <= request.afterID {
			continue
		}
		timeline.Snapshots = append(timeline.Snapshots, ref)
	}
	return timeline, true, nil
}
