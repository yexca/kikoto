package httpapi

// mediaLyricsChoice is one lyrics file a track location can play, as the work
// media response ranks them.
type mediaLyricsChoice struct {
	LyricsMediaItemID int64 `json:"lyricsMediaItemId"`
	// LocationID is the local location of the lyrics file that is read.
	LocationID int64 `json:"locationId"`
	// Reason is "assigned" for a library lyrics assignment, or the way name
	// matching picked the file.
	Reason string `json:"reason"`
	// Language is the declared language of an assigned file; it is absent for
	// a name match and for a file assigned to every language.
	Language string `json:"language,omitempty"`
}

// attachMediaLyricsChoices ranks the lyrics choices of every audio and video
// location the work media lists: the item's library lyrics assignments first,
// in the order the viewer's languages try them, then the available local
// lyrics files of the work that name matching picks for the location's path.
// It also records the name match on its own, which applies where no
// assignment does.
func attachMediaLyricsChoices(items []mediaItemDetail) {
	candidates := []lyricsMatchCandidate{}
	candidateFiles := []mediaLyricsChoice{}
	// The first available local location of each item is where an assigned
	// file is read.
	firstLocal := map[int64]int64{}
	for _, item := range items {
		for _, location := range item.Locations {
			if location.LocationType != "local" || location.Availability != "available" {
				continue
			}
			if _, ok := firstLocal[item.ID]; !ok {
				firstLocal[item.ID] = location.ID
			}
			if isLyricsMatchPath(location.Path) {
				candidates = append(candidates, newLyricsMatchCandidate(location.Path))
				candidateFiles = append(candidateFiles, mediaLyricsChoice{LyricsMediaItemID: item.ID, LocationID: location.ID})
			}
		}
	}
	for itemIndex := range items {
		item := &items[itemIndex]
		if item.Kind != "audio" && item.Kind != "video" {
			continue
		}
		assigned := []mediaLyricsChoice{}
		assignedItems := map[int64]bool{}
		for _, assignment := range item.LyricsAssignments {
			locationID, ok := firstLocal[assignment.LyricsMediaItemID]
			if assignedItems[assignment.LyricsMediaItemID] || !ok {
				continue
			}
			assignedItems[assignment.LyricsMediaItemID] = true
			assigned = append(assigned, mediaLyricsChoice{
				LyricsMediaItemID: assignment.LyricsMediaItemID, LocationID: locationID,
				Reason: lyricsReasonAssigned, Language: assignment.Language,
			})
		}
		for locationIndex := range item.Locations {
			location := &item.Locations[locationIndex]
			if location.Availability != "available" && location.Availability != "remote" {
				continue
			}
			choices := append([]mediaLyricsChoice{}, assigned...)
			for rank, match := range rankLyricsMatches(location.Path, candidates) {
				file := candidateFiles[match.index]
				if rank == 0 {
					id := file.LyricsMediaItemID
					location.LyricsMatchMediaItemID = &id
				}
				if assignedItems[file.LyricsMediaItemID] {
					continue
				}
				file.Reason = match.reason
				choices = append(choices, file)
			}
			if len(choices) > 0 {
				location.LyricsChoices = choices
			}
		}
	}
}

// remoteLyricsChoice is one lyrics file of a remote edition's tree that a
// track can play, addressed by its tree path.
type remoteLyricsChoice struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// attachRemoteLyricsChoices ranks, for every audio and video file of a remote
// edition's tree, the lyrics files of the same tree that name matching picks.
func attachRemoteLyricsChoices(tracks []remoteTrackDetail) {
	type treeFile struct {
		track *remoteTrackDetail
		path  string
	}
	files := []treeFile{}
	var walk func(nodes []remoteTrackDetail, basePath string)
	walk = func(nodes []remoteTrackDetail, basePath string) {
		for index := range nodes {
			node := &nodes[index]
			path := remoteTrackPath(basePath, node.Title)
			if len(node.Children) > 0 || node.Type == "folder" {
				walk(node.Children, path)
				continue
			}
			files = append(files, treeFile{track: node, path: path})
		}
	}
	walk(tracks, "")
	candidates := []lyricsMatchCandidate{}
	for _, file := range files {
		if isLyricsMatchPath(file.path) {
			candidates = append(candidates, newLyricsMatchCandidate(file.path))
		}
	}
	if len(candidates) == 0 {
		return
	}
	for _, file := range files {
		// The listed type already names the kind its path tells.
		if file.track.Type != "audio" && file.track.Type != "video" {
			continue
		}
		for _, match := range rankLyricsMatches(file.path, candidates) {
			file.track.LyricsChoices = append(file.track.LyricsChoices, remoteLyricsChoice{
				Path: candidates[match.index].path, Reason: match.reason,
			})
		}
	}
}
