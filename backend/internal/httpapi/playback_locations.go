package httpapi

import (
	"fmt"
	"sort"
)

// playbackLocation is one location a media item plays from, with the URL the
// player streams it through.
type playbackLocation struct {
	LocationID   int64  `json:"locationId"`
	LocationType string `json:"locationType"`
	StreamURL    string `json:"streamUrl"`
	SourceID     int64  `json:"sourceId"`
	SourceName   string `json:"sourceName"`
	Availability string `json:"availability"`
}

// playbackLocationRank is the location priority of playback: a local file
// first, then a cached copy, then a remote stream.
func playbackLocationRank(locationType string) int {
	switch locationType {
	case "local":
		return 0
	case "cache":
		return 1
	case "remote_stream":
		return 2
	default:
		return 3
	}
}

// playbackLocationUsable reports a location that can play now: an available
// file or a remote stream. A local file on an offline storage pool is
// "offline" and never usable.
func playbackLocationUsable(availability string) bool {
	return availability == "available" || availability == "remote"
}

// locationPlaybackURL is the URL that serves a location: its stream URL, or
// a remote location's download URL. Remote audio and video always stream
// through the location's own route, so the server can convert or proxy it.
func locationPlaybackURL(location fileLocationDetail, kind string) string {
	if location.LocationType == "remote_stream" && (kind == "audio" || kind == "video") && location.ID > 0 {
		if location.StreamURL == "" && location.DownloadURL == "" {
			return ""
		}
		return fmt.Sprintf("/api/media/%d/stream", location.ID)
	}
	if location.StreamURL != "" {
		return location.StreamURL
	}
	if location.LocationType == "remote_stream" {
		return location.DownloadURL
	}
	return ""
}

// orderedPlaybackLocations lists the locations an item can play from now, in
// playback priority; locations of one type keep the source priority order the
// work media lists them in. Every playback choice of a track starts from this
// list: the work page's queues, Resume, a restored queue, and the fallback
// after a location fails.
func orderedPlaybackLocations(item mediaItemDetail) []playbackLocation {
	locations := []playbackLocation{}
	for _, location := range item.Locations {
		if !playbackLocationUsable(location.Availability) {
			continue
		}
		url := locationPlaybackURL(location, item.Kind)
		if url == "" {
			continue
		}
		locations = append(locations, playbackLocation{
			LocationID:   location.ID,
			LocationType: location.LocationType,
			StreamURL:    url,
			SourceID:     location.FileSourceID,
			SourceName:   location.FileSourceName,
			Availability: location.Availability,
		})
	}
	sort.SliceStable(locations, func(i, j int) bool {
		return playbackLocationRank(locations[i].LocationType) < playbackLocationRank(locations[j].LocationType)
	})
	return locations
}

// attachPlaybackLocations gives every media item its ordered playback
// locations.
func attachPlaybackLocations(items []mediaItemDetail) {
	for index := range items {
		items[index].PlaybackLocations = orderedPlaybackLocations(items[index])
	}
}

// keptPlaybackLocation is the location a queued track continues on: the one
// it was on when the listener picked it in the player, or when it is of the
// same type as the first choice, such as another local folder; otherwise the
// first choice. It is nil when the item has no usable location.
func keptPlaybackLocation(locations []playbackLocation, currentLocationID int64, listenerChosen bool) *playbackLocation {
	if len(locations) == 0 {
		return nil
	}
	preferred := &locations[0]
	for index := range locations {
		current := &locations[index]
		if current.LocationID != currentLocationID {
			continue
		}
		if listenerChosen || current.LocationType == preferred.LocationType {
			return current
		}
		break
	}
	return preferred
}
