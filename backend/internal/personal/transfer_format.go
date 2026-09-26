package personal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const MaxTransferBytes = 10 << 20
const maxTransferWorks = 20000
const maxTransferTags = 5000
const maxTransferLists = 1000
const maxTransferItems = 50000

var primaryCodePattern = regexp.MustCompile(`^(RJ|BJ|VJ|CC)[0-9]{5,8}$`)

type Backup struct {
	Format     string           `json:"format"`
	Version    int              `json:"version"`
	ExportedAt string           `json:"exportedAt,omitempty"`
	Works      []BackupWork     `json:"works"`
	Playlists  []BackupPlaylist `json:"playlists"`
	Tags       []BackupTag      `json:"tags"`
}

type BackupWork struct {
	PrimaryCode     string            `json:"primaryCode"`
	ListeningStatus string            `json:"listeningStatus"`
	Rating          *int              `json:"rating"`
	Note            string            `json:"note"`
	Tags            []string          `json:"tags"`
	Progress        *BackupProgress   `json:"progress,omitempty"`
	Statistics      *BackupStatistics `json:"statistics,omitempty"`
}

type BackupProgress struct {
	MediaWorkCode   string   `json:"mediaWorkCode"`
	MediaTitle      string   `json:"mediaTitle"`
	TrackNumber     *int     `json:"trackNumber"`
	DiscNumber      *int     `json:"discNumber"`
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Completed       bool     `json:"completed"`
	LastPlayedAt    string   `json:"lastPlayedAt"`
}

type BackupStatistics struct {
	ListenedSeconds float64 `json:"listenedSeconds"`
	ListenCount     int64   `json:"listenCount"`
	LastPlayedAt    string  `json:"lastPlayedAt"`
}

type BackupTag struct {
	Scope string `json:"scope"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type BackupPlaylist struct {
	Name        string               `json:"name"`
	Description string               `json:"description"`
	SortOrder   int64                `json:"sortOrder"`
	Items       []BackupPlaylistItem `json:"items"`
}

type BackupPlaylistItem struct {
	PrimaryCode string `json:"primaryCode"`
	Note        string `json:"note"`
	SortOrder   int64  `json:"sortOrder"`
}

type ImportRequest struct {
	Format   string          `json:"format"`
	Data     json.RawMessage `json:"data"`
	Conflict string          `json:"conflict"`
}

func DecodeJSON(data []byte, value any, strict bool) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(value); err != nil {
		return ErrInvalid
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return ErrInvalid
	}
	return nil
}

func ParseImport(request ImportRequest) (Backup, error) {
	if len(request.Data) > MaxTransferBytes {
		return Backup{}, ErrLimit
	}
	if request.Conflict != "" && request.Conflict != "keep" && request.Conflict != "overwrite" {
		return Backup{}, ErrInvalid
	}
	var backup Backup
	switch request.Format {
	case "kikoto":
		if err := DecodeJSON(request.Data, &backup, true); err != nil {
			return backup, err
		}
		if backup.Format != "kikoto-user-data" || backup.Version != 1 {
			return backup, ErrInvalid
		}
	case "kikoeru":
		var err error
		backup, err = parseKikoeru(request.Data)
		if err != nil {
			return backup, err
		}
	default:
		return backup, ErrInvalid
	}
	return backup, validateBackup(&backup)
}

func normalizeTimestamp(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil && parsed.Year() >= 1970 && parsed.Before(time.Now().Add(24*time.Hour)) {
			return parsed.UTC().Format("2006-01-02 15:04:05"), nil
		}
	}
	return "", ErrInvalid
}

func normalizeCode(value string) (string, error) {
	value = strings.ToUpper(strings.TrimSpace(value))
	if !primaryCodePattern.MatchString(value) {
		return "", ErrInvalid
	}
	return value, nil
}

func validStatus(status string) bool {
	switch status {
	case "none", "want_to_listen", "listening", "finished", "relisten", "paused":
		return true
	}
	return false
}

// SQLite's built-in LOWER, used by the existing tag store, folds ASCII only.
func tagNameKey(name string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, name)
}

func validateBackup(b *Backup) error {
	if len(b.Works) > maxTransferWorks || len(b.Playlists) > maxTransferLists || len(b.Tags) > maxTransferTags {
		return ErrLimit
	}
	seen := map[string]bool{}
	items := 0
	assignments := 0
	for i := range b.Works {
		w := &b.Works[i]
		assignments += len(w.Tags)
		if assignments > maxTransferItems {
			return ErrLimit
		}
		code, err := normalizeCode(w.PrimaryCode)
		if err != nil || seen[code] {
			return ErrInvalid
		}
		seen[code], w.PrimaryCode = true, code
		if !validStatus(w.ListeningStatus) || len(w.Tags) > maxTransferTags || (w.Rating != nil && (*w.Rating < 0 || *w.Rating > 5)) {
			return ErrInvalid
		}
		tagSeen := map[string]bool{}
		for j, name := range w.Tags {
			name = strings.TrimSpace(name)
			if !validTagName(name) || tagSeen[tagNameKey(name)] {
				return ErrInvalid
			}
			tagSeen[tagNameKey(name)], w.Tags[j] = true, name
		}
		if p := w.Progress; p != nil {
			p.MediaWorkCode, err = normalizeCode(p.MediaWorkCode)
			if err != nil || !validNumber(p.PositionSeconds) || p.PositionSeconds > 31536000 || (p.DurationSeconds != nil && (!validNumber(*p.DurationSeconds) || *p.DurationSeconds > 31536000 || p.PositionSeconds > *p.DurationSeconds)) {
				return ErrInvalid
			}
			p.LastPlayedAt, err = normalizeTimestamp(p.LastPlayedAt)
			if err != nil {
				return err
			}
		}
		if stats := w.Statistics; stats != nil {
			if !validNumber(stats.ListenedSeconds) || stats.ListenedSeconds > 1e12 || stats.ListenCount < 0 || stats.ListenCount > 1e9 {
				return ErrInvalid
			}
			stats.LastPlayedAt, err = normalizeTimestamp(stats.LastPlayedAt)
			if err != nil {
				return err
			}
		}
	}
	seen = map[string]bool{}
	for i := range b.Tags {
		tag := &b.Tags[i]
		tag.Name = strings.TrimSpace(tag.Name)
		key := tag.Scope + ":" + tagNameKey(tag.Name)
		if _, ok := tagScopes[tag.Scope]; !ok || !validTagName(tag.Name) || len(tag.Color) > 64 || seen[key] {
			return ErrInvalid
		}
		seen[key] = true
	}
	seen = map[string]bool{}
	for i := range b.Playlists {
		list := &b.Playlists[i]
		list.Name = strings.TrimSpace(list.Name)
		// Text already shares the bounded file budget. Existing list names and
		// personal notes have no smaller field limit, so do not truncate backups.
		if list.Name == "" || seen[list.Name] {
			return ErrInvalid
		}
		// Favorite-list names use the existing exact-name uniqueness contract.
		seen[list.Name] = true
		items += len(list.Items)
		if items > maxTransferItems {
			return ErrLimit
		}
		codes := map[string]bool{}
		for j := range list.Items {
			item := &list.Items[j]
			code, err := normalizeCode(item.PrimaryCode)
			if err != nil || codes[code] {
				return ErrInvalid
			}
			codes[code], item.PrimaryCode = true, code
		}
	}
	return nil
}

// Kikoeru review exports and /api/review pages carry per-work progress strings.
// Numeric legacy work_id/id is a product number (RJ), never a Kikoto database id.
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
	statuses := map[string]string{"": "none", "marked": "want_to_listen", "listening": "listening", "listened": "finished", "replay": "relisten", "postponed": "paused"}
	b := Backup{Format: "kikoto-user-data", Version: 1, Works: []BackupWork{}, Playlists: []BackupPlaylist{}, Tags: []BackupTag{}}
	for _, r := range reviews {
		code := r.PrimaryCode
		if code == "" {
			code = r.SourceID
		}
		if code == "" {
			raw := r.WorkID
			if len(raw) == 0 || string(raw) == "null" {
				raw = r.ID
			}
			var text string
			if json.Unmarshal(raw, &text) != nil {
				text = string(raw)
			}
			if number, err := strconv.ParseInt(text, 10, 64); err == nil && number >= 0 && number <= 99999999 {
				width := 6
				if number >= 1000000 {
					width = 8
				}
				code = fmt.Sprintf("RJ%0*d", width, number)
			} else {
				code = text
			}
		}
		progress := ""
		if r.Progress != nil {
			progress = *r.Progress
		}
		status, ok := statuses[progress]
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
