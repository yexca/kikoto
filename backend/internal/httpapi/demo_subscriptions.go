package httpapi

import "time"

// Demo shows Subscriptions with a fixed synthetic feed. Every name is an
// obvious sample, every code comes from the repository-reserved RJ00000000
// sequence, and nothing is stored, refreshed, or linked to a real work.

type demoReleaseFeedEntry struct {
	code, title, eventType, at, language, subjectKind, subjectName, releaseDate, circle string
	voiceActors, tags                                                                   []string
}

var demoReleaseFeedEntries = []demoReleaseFeedEntry{
	{"RJ00000097", "Example Work 7", "released", "2026-10-14 09:00:00", "ja-jp", "circle", "Example Circle 1", "2026-10-14", "Example Circle 1", []string{"Example Voice 1"}, []string{"Example tag"}},
	{"RJ00000092", "Example Work 2", "released", "2026-10-14 08:30:00", "ja-jp", "voice", "Example Voice 1", "2026-10-14", "Example Circle 2", []string{"Example Voice 1"}, []string{"Example tag"}},
	{"RJ00000096", "Example Work 6", "available", "2026-10-13 09:00:00", "ja-jp", "watch", "", "2026-10-05", "Example Circle 2", []string{"Example Voice 2"}, []string{"Example tag"}},
	{"RJ00000095", "Example Work 5 (English)", "edition", "2026-10-12 09:00:00", "en-us", "series", "Example Series 1", "2026-10-12", "Example Circle 3", []string{"Example Voice 1"}, []string{"Example tag"}},
	{"RJ00000091", "Example Work 1", "released", "2026-10-12 08:30:00", "ja-jp", "circle", "Example Circle 3", "2026-10-12", "Example Circle 3", []string{"Example Voice 3"}, []string{"Example tag"}},
	{"RJ00000094", "Example Work 4", "released", "2026-10-10 09:00:00", "ja-jp", "voice", "Example Voice 2", "2026-10-10", "Example Circle 3", []string{"Example Voice 2", "Example Voice 3"}, []string{"Example tag"}},
	{"RJ00000093", "Example Work 3", "released", "2026-10-08 09:00:00", "ja-jp", "circle", "Example Circle 2", "2026-10-08", "Example Circle 2", []string{"Example Voice 3"}, []string{"Example tag"}},
}

func demoReleaseFeedPage(page, days int, location *time.Location) releaseFeedPage {
	result := releaseFeedPage{Page: page, Days: days, Total: len(demoReleaseFeedEntries), Demo: true}
	families := []releaseFeedFamily{}
	for index, entry := range demoReleaseFeedEntries {
		subject := releaseFeedSubject{Kind: entry.subjectKind}
		switch entry.subjectKind {
		case "circle":
			subject.CircleName = entry.subjectName
		case "series":
			subject.CircleName, subject.SeriesName = entry.circle, entry.subjectName
		case "voice":
			subject.VoiceName = entry.subjectName
		}
		families = append(families, releaseFeedFamily{
			Key: "demo:" + entry.code, LatestAt: entry.at, Unread: index < 2,
			Events: []releaseFeedEvent{{Type: entry.eventType, Code: entry.code, Language: entry.language, At: entry.at, Subject: subject}},
			Fallback: releaseFeedFallback{
				Code: entry.code, Title: entry.title, ReleaseDate: entry.releaseDate, Circle: entry.circle,
				VoiceActors: entry.voiceActors, Tags: entry.tags,
			},
		})
	}
	result.Families, result.TotalDays = pageReleaseFeedDays(families, page, days, location)
	return result
}

func demoCreatorSubscriptionView() map[string]any {
	activated := "2026-09-01 09:00:00"
	subscriptions := []creatorSubscription{
		{ID: 1, Kind: "circle", CircleName: "Example Circle 1", Status: "active", ActivatedAt: &activated, CreatedAt: activated, CatalogSyncedAt: &activated},
		{ID: 2, Kind: "circle", CircleName: "Example Circle 2", WatchAvailability: true, Status: "active", ActivatedAt: &activated, CreatedAt: activated, CatalogSyncedAt: &activated},
		{ID: 3, Kind: "series", CircleName: "Example Circle 3", SeriesName: "Example Series 1", Status: "active", ActivatedAt: &activated, CreatedAt: activated, CatalogSyncedAt: &activated},
		{ID: 4, Kind: "voice", VoiceName: "Example Voice 2", Status: "pending", CreatedAt: activated},
	}
	return map[string]any{
		"subscriptions": subscriptions,
		"schedule":      creatorSubscriptionSchedule{Enabled: true, IntervalHours: creatorSubscriptionDefaultIntervalHours, AvailabilityWatch: true},
		"demo":          true,
	}
}
