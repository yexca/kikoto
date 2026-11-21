package record

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
)

// A folder shows its children in sections, each in natural name order:
// subfolders, videos, photos, and a list of its other files. Audio files are
// listed among the files and, as their own section, are what the player
// queues. An image named as artwork (folder, poster, cover, backdrop, fanart,
// background) is never a photo. Each section pages on its own.
const (
	SectionFolders = "folders"
	SectionVideos  = "videos"
	SectionPhotos  = "photos"
	SectionAudio   = "audio"
	SectionFiles   = "files"
)

// Sections lists the sections in the order a folder shows them.
var Sections = []string{SectionFolders, SectionVideos, SectionPhotos, SectionAudio, SectionFiles}

// SectionPageMax bounds one page of a section.
const SectionPageMax = 100

// ErrInvalidCursor refuses a page cursor the store did not hand out.
var ErrInvalidCursor = errors.New("invalid record listing cursor")

// ErrUnknownSection refuses a section name outside Sections.
var ErrUnknownSection = errors.New("unknown record section")

// assetSectionFilters select, on record_asset a, the available files of each
// asset section; a.folder_id and a.availability are filtered by the caller.
var assetSectionFilters = map[string]string{
	SectionVideos: `a.kind='video'`,
	SectionPhotos: `a.kind='image' AND lower(substr(a.name, 1, length(a.name)-length(a.extension))) NOT IN (` + artworkStemList() + `)`,
	SectionAudio:  `a.kind='audio'`,
	SectionFiles:  `a.kind IN ('audio','subtitle','metadata','other')`,
}

func artworkStemList() string {
	quoted := []string{}
	for _, role := range []string{"poster", "backdrop"} {
		for _, stem := range artworkStems[role] {
			quoted = append(quoted, "'"+stem+"'")
		}
	}
	return strings.Join(quoted, ",")
}

// SectionPage is one page of a section: Folders for the folders section,
// Assets for every other.
type SectionPage struct {
	Section string
	Folders []Folder
	Assets  []Asset
	// Total counts the section's children on every page.
	Total int
	// Next is the cursor of the following page, or "" on the last page.
	Next string
}

// FolderView is the first page of each section of one folder, with the
// folder's trail.
type FolderView struct {
	// Trail is the listed folder and the folders above it, below the root.
	Trail    []Folder
	Sections []SectionPage
}

// sectionCursor is where a page starts: just after the child it names.
type sectionCursor struct {
	Key  []byte `json:"k"`
	Name string `json:"n"`
	ID   int64  `json:"i"`
}

func encodeCursor(key []byte, name string, id int64) string {
	data, _ := json.Marshal(sectionCursor{Key: key, Name: name, ID: id})
	return base64.RawURLEncoding.EncodeToString(data)
}

func decodeCursor(value string) (*sectionCursor, error) {
	if value == "" {
		return nil, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, ErrInvalidCursor
	}
	var cursor sectionCursor
	if err := json.Unmarshal(data, &cursor); err != nil || cursor.ID <= 0 {
		return nil, ErrInvalidCursor
	}
	return &cursor, nil
}

// resolveFolder returns the folder a listing names: the root folder for 0.
// found is false when the root has never been scanned.
func (s *Store) resolveFolder(ctx context.Context, folderID int64) (int64, bool, error) {
	if folderID > 0 {
		return folderID, true, nil
	}
	err := s.db.QueryRowContext(ctx, `SELECT id FROM record_folder WHERE root_id=1 AND path_key='.'`).Scan(&folderID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return folderID, err == nil, err
}

// FolderView lists the first page of every section of one folder, the root
// when folderID is 0, with userID's saved progress on each video and audio
// file.
func (s *Store) FolderView(ctx context.Context, folderID int64, limit int, userID int64) (FolderView, error) {
	view := FolderView{Trail: []Folder{}, Sections: []SectionPage{}}
	if err := s.ensureDerived(ctx); err != nil {
		return FolderView{}, err
	}
	resolved, found, err := s.resolveFolder(ctx, folderID)
	if err != nil {
		return FolderView{}, err
	}
	if folderID > 0 {
		if view.Trail, err = s.folderTrail(ctx, folderID); err != nil {
			return FolderView{}, err
		}
	}
	for _, section := range Sections {
		page := SectionPage{Section: section, Folders: []Folder{}, Assets: []Asset{}}
		if found {
			if page, err = s.listSection(ctx, resolved, section, nil, limit, userID); err != nil {
				return FolderView{}, err
			}
		}
		view.Sections = append(view.Sections, page)
	}
	return view, nil
}

// ListSection lists the page of one section of a folder, the root when
// folderID is 0, that follows the cursor after; "" starts at the beginning.
func (s *Store) ListSection(ctx context.Context, folderID int64, section, after string, limit int, userID int64) (SectionPage, error) {
	if section != SectionFolders && assetSectionFilters[section] == "" {
		return SectionPage{}, ErrUnknownSection
	}
	cursor, err := decodeCursor(after)
	if err != nil {
		return SectionPage{}, err
	}
	if err := s.ensureDerived(ctx); err != nil {
		return SectionPage{}, err
	}
	resolved, found, err := s.resolveFolder(ctx, folderID)
	if err != nil {
		return SectionPage{}, err
	}
	if !found {
		return SectionPage{Section: section, Folders: []Folder{}, Assets: []Asset{}}, nil
	}
	return s.listSection(ctx, resolved, section, cursor, limit, userID)
}

func (s *Store) listSection(ctx context.Context, folderID int64, section string, cursor *sectionCursor, limit int, userID int64) (SectionPage, error) {
	if limit <= 0 || limit > SectionPageMax {
		limit = SectionPageMax
	}
	page := SectionPage{Section: section, Folders: []Folder{}, Assets: []Asset{}}
	after, args := "", []any{}
	if cursor != nil {
		after = ` AND (x.sort_key, x.name, x.id) > (?, ?, ?)`
		args = append(args, cursor.Key, cursor.Name, cursor.ID)
	}
	type keyed struct {
		key  []byte
		name string
		id   int64
	}
	keys := []keyed{}
	if section == SectionFolders {
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM record_folder WHERE parent_id=? AND state='active'`, folderID).Scan(&page.Total); err != nil {
			return SectionPage{}, err
		}
		rows, err := s.db.QueryContext(ctx, `SELECT `+folderColumns+`, f.sort_key FROM record_folder f `+folderArtworkJoins+`
			WHERE f.parent_id=? AND f.state='active'`+strings.ReplaceAll(after, "x.", "f.")+`
			ORDER BY f.sort_key, f.name, f.id LIMIT ?`, append(append([]any{folderID}, args...), limit+1)...)
		if err != nil {
			return SectionPage{}, err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var f Folder
			var key []byte
			if err := rows.Scan(&f.ID, &f.ParentID, &f.Name, &f.RelativePath, &f.Depth, &f.ChildCount, &f.AssetCount, &f.HasPoster, &f.HasBackdrop, &key); err != nil {
				return SectionPage{}, err
			}
			page.Folders = append(page.Folders, f)
			keys = append(keys, keyed{key, f.Name, f.ID})
		}
		if err := rows.Err(); err != nil {
			return SectionPage{}, err
		}
		if len(page.Folders) > limit {
			page.Folders = page.Folders[:limit]
		}
	} else {
		filter := assetSectionFilters[section]
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM record_asset a WHERE a.folder_id=? AND a.availability='available' AND `+filter, folderID).Scan(&page.Total); err != nil {
			return SectionPage{}, err
		}
		assets, assetKeys, err := s.queryAssets(ctx, userID,
			`a.folder_id=? AND a.availability='available' AND `+filter+strings.ReplaceAll(after, "x.", "a."),
			`a.sort_key, a.name, a.id`, limit+1, append([]any{folderID}, args...)...)
		if err != nil {
			return SectionPage{}, err
		}
		for i, a := range assets {
			keys = append(keys, keyed{assetKeys[i], a.Name, a.ID})
		}
		if len(assets) > limit {
			assets = assets[:limit]
		}
		if section == SectionVideos {
			if err := s.pairSubtitles(ctx, folderID, assets); err != nil {
				return SectionPage{}, err
			}
		}
		page.Assets = assets
	}
	if len(keys) > limit {
		last := keys[limit-1]
		page.Next = encodeCursor(last.key, last.name, last.id)
	}
	return page, nil
}

// queryAssets lists assets matching where, with userID's progress on videos
// and audio files, and each one's sort key.
func (s *Store) queryAssets(ctx context.Context, userID int64, where, order string, limit int, args ...any) ([]Asset, [][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+assetColumns+`, `+progressColumns+`, a.sort_key
		FROM record_asset a LEFT JOIN record_asset_progress p ON p.asset_id=a.id AND p.user_id=? AND a.kind IN ('video','audio')
		WHERE `+where+` ORDER BY `+order+` LIMIT ?`, append(append([]any{userID}, args...), limit)...)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	assets, keys := []Asset{}, [][]byte{}
	for rows.Next() {
		var progress progressFields
		var key []byte
		a, err := scanAsset(rows, append(progress.dest(), &key)...)
		if err != nil {
			return nil, nil, err
		}
		a.Progress = progress.progress()
		assets = append(assets, a)
		keys = append(keys, key)
	}
	return assets, keys, rows.Err()
}

// pairSubtitles gives each video the served WebVTT or SubRip file in its
// folder whose name, without the extension, matches the video's, ignoring
// case; WebVTT comes first.
func (s *Store) pairSubtitles(ctx context.Context, folderID int64, videos []Asset) error {
	if len(videos) == 0 {
		return nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+assetColumns+` FROM record_asset a
		WHERE a.folder_id=? AND a.availability='available' AND a.kind='subtitle' AND a.extension IN ('.vtt','.srt')`, folderID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	byStem := map[string]Asset{}
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			return err
		}
		if !ServesSubtitle(a.Name) {
			continue
		}
		stem := assetStem(a.Name)
		if known, ok := byStem[stem]; !ok || (strings.EqualFold(filepath.Ext(a.Name), ".vtt") && !strings.EqualFold(filepath.Ext(known.Name), ".vtt")) {
			byStem[stem] = a
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range videos {
		if subtitle, ok := byStem[assetStem(videos[i].Name)]; ok {
			videos[i].Subtitle = &subtitle
		}
	}
	return nil
}

func assetStem(name string) string {
	return strings.ToLower(strings.TrimSuffix(name, filepath.Ext(name)))
}

// Siblings places one asset in its section: its position, the section's
// size, and the files before and after it.
type Siblings struct {
	Asset    Asset
	Section  string
	Index    int
	Total    int
	Previous *Asset
	Next     *Asset
}

// AssetSiblings places an available video, photo, or audio file in its
// section, with userID's progress; any other asset is sql.ErrNoRows.
func (s *Store) AssetSiblings(ctx context.Context, assetID int64, userID int64) (Siblings, error) {
	if err := s.ensureDerived(ctx); err != nil {
		return Siblings{}, err
	}
	assets, keys, err := s.queryAssets(ctx, userID, `a.id=? AND a.availability='available'`, `a.id`, 1, assetID)
	if err != nil {
		return Siblings{}, err
	}
	if len(assets) == 0 {
		return Siblings{}, sql.ErrNoRows
	}
	asset, key := assets[0], keys[0]
	section := ""
	for _, candidate := range []string{SectionVideos, SectionPhotos, SectionAudio} {
		var matches bool
		if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM record_asset a WHERE a.id=? AND `+assetSectionFilters[candidate]+`)`, assetID).Scan(&matches); err != nil {
			return Siblings{}, err
		}
		if matches {
			section = candidate
			break
		}
	}
	if section == "" {
		return Siblings{}, sql.ErrNoRows
	}
	in := `a.folder_id=? AND a.availability='available' AND ` + assetSectionFilters[section]
	found := Siblings{Asset: asset, Section: section}
	if err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM record_asset a WHERE `+in+`),
		(SELECT COUNT(*) FROM record_asset a WHERE `+in+` AND (a.sort_key, a.name, a.id) < (?, ?, ?))`,
		asset.FolderID, asset.FolderID, key, asset.Name, asset.ID).Scan(&found.Total, &found.Index); err != nil {
		return Siblings{}, err
	}
	previous, _, err := s.queryAssets(ctx, userID, in+` AND (a.sort_key, a.name, a.id) < (?, ?, ?)`, `a.sort_key DESC, a.name DESC, a.id DESC`, 1, asset.FolderID, key, asset.Name, asset.ID)
	if err != nil {
		return Siblings{}, err
	}
	next, _, err := s.queryAssets(ctx, userID, in+` AND (a.sort_key, a.name, a.id) > (?, ?, ?)`, `a.sort_key, a.name, a.id`, 1, asset.FolderID, key, asset.Name, asset.ID)
	if err != nil {
		return Siblings{}, err
	}
	if len(previous) > 0 {
		found.Previous = &previous[0]
	}
	if len(next) > 0 {
		found.Next = &next[0]
	}
	if section == SectionVideos {
		single := []Asset{found.Asset}
		if err := s.pairSubtitles(ctx, asset.FolderID, single); err != nil {
			return Siblings{}, err
		}
		found.Asset = single[0]
	}
	return found, nil
}
