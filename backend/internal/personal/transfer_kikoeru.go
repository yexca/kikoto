package personal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Kikoeru forks encode the product type in numeric work ids as
// type index * 1e12 + digits; plain RJ ids are therefore the digits alone.
const kikoeruIDSplitter = 1_000_000_000_000

var kikoeruIDTypes = []string{"RJ", "BJ", "VJ", "CC"}

var kikoeruStatuses = map[string]string{
	"":          "none",
	"marked":    "want_to_listen",
	"listening": "listening",
	"listened":  "finished",
	"replay":    "relisten",
	"postponed": "paused",
}

// Account imports read at most what one backup can hold.
const (
	MaxKikoeruWorks         = maxTransferWorks
	MaxKikoeruPlaylistItems = maxTransferItems
)

// Remote account data has no file budget of its own, so a single review note is
// bounded before the whole backup is checked against MaxTransferBytes.
const maxKikoeruNoteRunes = 20000
const maxKikoeruListTextRunes = 2000

// KikoeruNumericCode decodes a numeric Kikoeru work id into a product code. It
// never treats the id as a Kikoto database id.
func KikoeruNumericCode(id int64) (string, bool) {
	if id < 0 {
		return "", false
	}
	typeIndex := id / kikoeruIDSplitter
	digits := id % kikoeruIDSplitter
	if typeIndex >= int64(len(kikoeruIDTypes)) || digits > 99999999 {
		return "", false
	}
	width := 6
	if digits >= 1000000 {
		width = 8
	}
	return fmt.Sprintf("%s%0*d", kikoeruIDTypes[typeIndex], width, digits), true
}

// KikoeruWorkCode picks a product code from the identity fields a Kikoeru
// review or work row may carry: an explicit code first, then a numeric id.
func KikoeruWorkCode(primaryCode, sourceID string, ids ...json.RawMessage) string {
	for _, candidate := range []string{primaryCode, sourceID} {
		if code, err := normalizeCode(candidate); err == nil {
			return code
		}
	}
	for _, raw := range ids {
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var text string
		if json.Unmarshal(raw, &text) != nil {
			text = string(raw)
		}
		text = strings.TrimSpace(text)
		if number, err := strconv.ParseInt(text, 10, 64); err == nil {
			if code, ok := KikoeruNumericCode(number); ok {
				return code
			}
			return ""
		}
		if code, err := normalizeCode(text); err == nil {
			return code
		}
		return ""
	}
	return ""
}

// Kikoeru review exports and /api/review pages carry per-work progress strings.
// A file is an explicit user document, so any unreadable row rejects it.
func parseKikoeru(data []byte) (Backup, error) {
	type review struct {
		ID              json.RawMessage `json:"id"`
		WorkID          json.RawMessage `json:"work_id"`
		SourceID        string          `json:"source_id"`
		PrimaryCode     string          `json:"primaryCode"`
		Progress        *string         `json:"progress"`
		Rating          json.RawMessage `json:"rating"`
		UserRating      *int            `json:"userRating"`
		UserRatingSnake *int            `json:"user_rating"`
		ReviewText      string          `json:"review_text"`
	}
	var reviews []review
	if len(bytes.TrimSpace(data)) == 0 {
		return Backup{}, ErrInvalid
	}
	if bytes.TrimSpace(data)[0] == '[' {
		if err := DecodeJSON(data, &reviews, false); err != nil {
			return Backup{}, err
		}
	} else {
		var envelope struct {
			Works   []review `json:"works"`
			Reviews []review `json:"reviews"`
		}
		if err := DecodeJSON(data, &envelope, false); err != nil {
			return Backup{}, err
		}
		if envelope.Works != nil && envelope.Reviews != nil {
			return Backup{}, ErrInvalid
		}
		reviews = envelope.Works
		if reviews == nil {
			reviews = envelope.Reviews
		}
		if reviews == nil {
			return Backup{}, ErrInvalid
		}
	}
	b := emptyBackup()
	for _, r := range reviews {
		code := KikoeruWorkCode(r.PrimaryCode, r.SourceID, r.WorkID, r.ID)
		if code == "" {
			return Backup{}, ErrInvalid
		}
		progress := ""
		if r.Progress != nil {
			progress = *r.Progress
		}
		status, ok := kikoeruStatuses[progress]
		if !ok {
			return Backup{}, ErrInvalid
		}
		rating := r.UserRating
		if rating == nil {
			rating = r.UserRatingSnake
		}
		// Review rows expose rating; full work rows use rating for provider metadata.
		if rating == nil && len(r.WorkID) > 0 {
			if len(r.Rating) > 0 && json.Unmarshal(r.Rating, &rating) != nil {
				return Backup{}, ErrInvalid
			}
		}
		b.Works = append(b.Works, BackupWork{PrimaryCode: code, ListeningStatus: status, Rating: rating, Note: r.ReviewText, Tags: []string{}})
	}
	return b, nil
}

// KikoeruReview is one account review read from a Kikoeru-compatible server or
// database, reduced to the fields an import uses.
type KikoeruReview struct {
	Code       string
	Progress   string
	Rating     *int
	ReviewText string
}

// KikoeruPlaylist is one playlist owned by the account. System marks a
// server-defined list such as the account's liked works.
type KikoeruPlaylist struct {
	Name        string
	Description string
	System      string
	Codes       []string
}

// KikoeruPlaylistNames supplies display names for server-defined playlists.
type KikoeruPlaylistNames struct {
	Liked  string `json:"liked"`
	Marked string `json:"marked"`
}

// KikoeruSummary reports what an account conversion kept and skipped.
type KikoeruSummary struct {
	Works                int `json:"works"`
	SkippedWorks         int `json:"skippedWorks"`
	Playlists            int `json:"playlists"`
	SkippedPlaylistItems int `json:"skippedPlaylistItems"`
}

func emptyBackup() Backup {
	return Backup{Format: "kikoto-user-data", Version: 1, Works: []BackupWork{}, Playlists: []BackupPlaylist{}, Tags: []BackupTag{}}
}

// KikoeruAccountBackup converts account data fetched from a Kikoeru-compatible
// source into a Kikoto backup. Unlike a file import, rows the user cannot fix
// (an unknown code or progress value from a newer fork) are skipped and counted
// rather than rejecting the whole account.
func KikoeruAccountBackup(reviews []KikoeruReview, playlists []KikoeruPlaylist, names KikoeruPlaylistNames) (Backup, KikoeruSummary, error) {
	b := emptyBackup()
	var summary KikoeruSummary
	seen := map[string]bool{}
	for _, review := range reviews {
		code, err := normalizeCode(review.Code)
		if err != nil || seen[code] {
			summary.SkippedWorks++
			continue
		}
		seen[code] = true
		status, ok := kikoeruStatuses[review.Progress]
		if !ok {
			status = "none"
		}
		rating := review.Rating
		if rating != nil && (*rating < 0 || *rating > 5) {
			rating = nil
		}
		b.Works = append(b.Works, BackupWork{
			PrimaryCode:     code,
			ListeningStatus: status,
			Rating:          rating,
			Note:            truncateRunes(review.ReviewText, maxKikoeruNoteRunes),
			Tags:            []string{},
		})
	}
	usedNames := map[string]bool{}
	for _, playlist := range playlists {
		name := kikoeruPlaylistName(playlist, names)
		if playlist.System != "" && len(playlist.Codes) == 0 {
			continue
		}
		name = uniqueListName(name, usedNames)
		list := BackupPlaylist{
			Name:        name,
			Description: truncateRunes(playlist.Description, maxKikoeruListTextRunes),
			SortOrder:   int64(len(b.Playlists)),
			Items:       []BackupPlaylistItem{},
		}
		codes := map[string]bool{}
		for _, raw := range playlist.Codes {
			code, err := normalizeCode(raw)
			if err != nil || codes[code] {
				summary.SkippedPlaylistItems++
				continue
			}
			codes[code] = true
			list.Items = append(list.Items, BackupPlaylistItem{PrimaryCode: code, SortOrder: int64(len(list.Items))})
		}
		b.Playlists = append(b.Playlists, list)
	}
	if err := validateBackup(&b); err != nil {
		return Backup{}, KikoeruSummary{}, err
	}
	encoded, err := json.Marshal(b)
	if err != nil {
		return Backup{}, KikoeruSummary{}, err
	}
	if len(encoded) > MaxTransferBytes {
		return Backup{}, KikoeruSummary{}, ErrLimit
	}
	summary.Works = len(b.Works)
	summary.Playlists = len(b.Playlists)
	return b, summary, nil
}

func kikoeruPlaylistName(playlist KikoeruPlaylist, names KikoeruPlaylistNames) string {
	switch playlist.System {
	case "liked":
		return fallbackText(names.Liked, "Kikoeru Liked")
	case "marked":
		return fallbackText(names.Marked, "Kikoeru Marked")
	case "":
		return fallbackText(playlist.Name, "Kikoeru")
	default:
		return "Kikoeru " + truncateRunes(playlist.System, 64)
	}
}

func fallbackText(value, fallback string) string {
	value = strings.TrimSpace(truncateRunes(value, maxKikoeruListTextRunes))
	if value == "" {
		return fallback
	}
	return value
}

func uniqueListName(name string, used map[string]bool) string {
	candidate := name
	for suffix := 2; used[candidate]; suffix++ {
		candidate = fmt.Sprintf("%s (%d)", name, suffix)
	}
	used[candidate] = true
	return candidate
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
