// Package record owns the independent local video and image library.
// Record assets are deliberately not works and never enter the audio library
// identity model.
package record

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"golang.org/x/text/unicode/norm"
)

const markerName = ".kikoto-record"

var ignoredNames = map[string]bool{
	markerName: true, ".kikoto-staging": true, ".kikoto-backup": true,
	".kikoto-trash": true, "@eaDir": true, "__MACOSX": true,
	"#recycle": true, ".DS_Store": true, "Thumbs.db": true,
}

type Store struct {
	db   *sqlutil.DB
	root string
}

func NewStore(db *sqlutil.DB, root string) *Store { return &Store{db: db, root: root} }

type Root struct {
	ID             int64  `json:"id"`
	DisplayName    string `json:"displayName"`
	State          string `json:"state"`
	LastScanRunID  *int64 `json:"lastScanRunId,omitempty"`
	LastScannedAt  string `json:"lastScannedAt,omitempty"`
	ScanGeneration int64  `json:"scanGeneration"`
}

type Folder struct {
	ID           int64   `json:"id"`
	ParentID     *int64  `json:"parentId,omitempty"`
	Name         string  `json:"name"`
	RelativePath string  `json:"relativePath,omitempty"`
	Depth        int     `json:"depth"`
	ChildCount   int     `json:"childCount"`
	AssetCount   int     `json:"assetCount"`
	Artwork      Artwork `json:"artwork"`
}

type Asset struct {
	ID              int64    `json:"id"`
	FolderID        int64    `json:"folderId"`
	Name            string   `json:"name"`
	RelativePath    string   `json:"relativePath,omitempty"`
	Kind            string   `json:"kind"`
	MimeType        string   `json:"mimeType"`
	SizeBytes       *int64   `json:"sizeBytes,omitempty"`
	DurationSeconds *float64 `json:"durationSeconds,omitempty"`
	Width           *int     `json:"width,omitempty"`
	Height          *int     `json:"height,omitempty"`
	Availability    string   `json:"availability"`
	StreamURL       string   `json:"streamUrl,omitempty"`
}

type Artwork struct {
	PosterURL   string `json:"posterUrl,omitempty"`
	BackdropURL string `json:"backdropUrl,omitempty"`
}

type ScanResult struct {
	RootID        int64  `json:"rootId"`
	State         string `json:"state"`
	Folders       int    `json:"folders"`
	Assets        int    `json:"assets"`
	Unreadable    int    `json:"unreadableDirectories"`
	MissingMarked bool   `json:"missingMarked"`
}

type Progress struct {
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds,omitempty"`
	Completed       bool     `json:"completed"`
	LastPlayedAt    string   `json:"lastPlayedAt,omitempty"`
}

func (s *Store) EnsureRoot(ctx context.Context) (Root, error) {
	path := filepath.Clean(strings.TrimSpace(s.root))
	if path == "." || path == "" {
		return Root{ID: 1, DisplayName: "Records", State: "unconfigured"}, nil
	}
	if info, err := os.Stat(path); err != nil {
		state := "offline"
		if errors.Is(err, os.ErrNotExist) {
			state = "unconfigured"
		}
		_, _ = s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, state=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`, path, state)
		return s.rootRecord(ctx)
	} else if !info.IsDir() {
		_, _ = s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, state='unreadable', updated_at=CURRENT_TIMESTAMP WHERE id=1`, path)
		return s.rootRecord(ctx)
	}
	var expectedMarker string
	if err := s.db.QueryRowContext(ctx, `SELECT marker_id FROM record_root WHERE id=1`).Scan(&expectedMarker); err != nil {
		return Root{}, err
	}
	markerPath := filepath.Join(path, markerName)
	markerInfo, markerStatErr := os.Lstat(markerPath)
	if markerStatErr == nil && markerInfo.Mode()&os.ModeSymlink != 0 {
		_, _ = s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, state='offline', updated_at=CURRENT_TIMESTAMP WHERE id=1`, path)
		return s.rootRecord(ctx)
	}
	if markerStatErr != nil && !errors.Is(markerStatErr, os.ErrNotExist) {
		return Root{}, fmt.Errorf("inspect record marker: %w", markerStatErr)
	}
	marker, err := os.ReadFile(markerPath)
	if errors.Is(err, os.ErrNotExist) {
		_, _ = s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, state='unconfigured', updated_at=CURRENT_TIMESTAMP WHERE id=1`, path)
		return s.rootRecord(ctx)
	} else if err != nil {
		return Root{}, fmt.Errorf("read record marker: %w", err)
	} else if strings.TrimSpace(string(marker)) != "kikoto-record-v1" || (expectedMarker != "" && strings.TrimSpace(string(marker)) != expectedMarker) {
		_, _ = s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, state='offline', updated_at=CURRENT_TIMESTAMP WHERE id=1`, path)
		return s.rootRecord(ctx)
	}
	if expectedMarker == "" {
		_, _ = s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, state='unconfigured', updated_at=CURRENT_TIMESTAMP WHERE id=1`, path)
		return s.rootRecord(ctx)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, marker_id=?, state='online', updated_at=CURRENT_TIMESTAMP WHERE id=1`, path, strings.TrimSpace(string(marker))); err != nil {
		return Root{}, err
	}
	return s.rootRecord(ctx)
}

// InitializeRoot is an explicit administrator action. Scanning never creates
// a marker because an empty mount point must not be mistaken for a library.
func (s *Store) InitializeRoot(ctx context.Context) (Root, error) {
	path := filepath.Clean(strings.TrimSpace(s.root))
	if path == "." || path == "" {
		return Root{}, errors.New("record root is not configured")
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return Root{}, err
	}
	markerPath := filepath.Join(path, markerName)
	if info, err := os.Lstat(markerPath); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return Root{}, errors.New("record root marker must not be a symbolic link")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Root{}, err
	}
	if marker, err := os.ReadFile(markerPath); err == nil {
		if strings.TrimSpace(string(marker)) != "kikoto-record-v1" {
			return Root{}, errors.New("record root marker is invalid")
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(markerPath, []byte("kikoto-record-v1\n"), 0o644); err != nil {
			return Root{}, err
		}
	} else {
		return Root{}, err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, marker_id='kikoto-record-v1', state='online', updated_at=CURRENT_TIMESTAMP WHERE id=1`, path)
	if err != nil {
		return Root{}, err
	}
	return s.rootRecord(ctx)
}

func (s *Store) rootRecord(ctx context.Context) (Root, error) {
	var out Root
	var last sql.NullString
	var runID sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT id, display_name, state, last_scan_run_id, last_scanned_at, scan_generation FROM record_root WHERE id=1`).Scan(&out.ID, &out.DisplayName, &out.State, &runID, &last, &out.ScanGeneration); err != nil {
		return Root{}, err
	}
	if runID.Valid {
		out.LastScanRunID = &runID.Int64
	}
	if last.Valid {
		out.LastScannedAt = last.String
	}
	return out, nil
}

func (s *Store) Root(ctx context.Context) (Root, error) { return s.rootRecord(ctx) }

func (s *Store) Scan(ctx context.Context) (ScanResult, error) {
	root, err := s.EnsureRoot(ctx)
	if err != nil {
		return ScanResult{}, err
	}
	if root.State != "online" {
		return ScanResult{RootID: root.ID, State: root.State}, nil
	}
	base := filepath.Clean(s.root)
	var generation int64
	if err := s.db.QueryRowContext(ctx, `SELECT scan_generation + 1 FROM record_root WHERE id=1`).Scan(&generation); err != nil {
		return ScanResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE record_root SET scan_generation=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`, generation); err != nil {
		return ScanResult{}, err
	}
	rootFolder, err := s.ensureFolder(ctx, nil, "", ".", 0, generation)
	if err != nil {
		return ScanResult{}, err
	}
	ids := map[string]int64{".": rootFolder}
	folders, assets := 1, 0
	unreadable := 0
	walkErr := filepath.WalkDir(base, func(path string, entry fs.DirEntry, err error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err != nil {
			unreadable++
			if path == base {
				return err
			}
			return fs.SkipDir
		}
		if path == base {
			return nil
		}
		name := entry.Name()
		if ignoredNames[name] {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if entry.IsDir() {
			parent := filepath.ToSlash(filepath.Dir(rel))
			if parent == "." {
				parent = "."
			}
			parentID := ids[parent]
			id, err := s.ensureFolder(ctx, &parentID, name, rel, strings.Count(rel, "/")+1, generation)
			if err != nil {
				return err
			}
			ids[rel] = id
			folders++
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		parent := filepath.ToSlash(filepath.Dir(rel))
		parentID, ok := ids[parent]
		if !ok {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			unreadable++
			return nil
		}
		kind, mime := classify(name)
		if _, err := s.upsertAsset(ctx, parentID, name, rel, kind, mime, info, generation); err != nil {
			return err
		}
		assets++
		return nil
	})
	if walkErr != nil && walkErr != filepath.SkipDir {
		unreadable++
	}
	complete := walkErr == nil && unreadable == 0
	if errors.Is(walkErr, context.Canceled) || errors.Is(walkErr, context.DeadlineExceeded) {
		return ScanResult{}, walkErr
	}
	if complete {
		if _, err := s.db.ExecContext(ctx, `UPDATE record_folder SET state=CASE WHEN last_seen_generation=? THEN 'active' ELSE 'missing' END, updated_at=CURRENT_TIMESTAMP WHERE root_id=1`, generation); err != nil {
			return ScanResult{}, err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE record_asset SET availability=CASE WHEN last_seen_generation=? THEN 'available' ELSE 'missing' END, updated_at=CURRENT_TIMESTAMP WHERE root_id=1`, generation); err != nil {
			return ScanResult{}, err
		}
	}
	state := "complete"
	if !complete {
		state = "partial"
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE record_root SET state='online', last_scanned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=1`); err != nil {
		return ScanResult{}, err
	}
	return ScanResult{RootID: root.ID, State: state, Folders: folders, Assets: assets, Unreadable: unreadable, MissingMarked: complete}, nil
}

func (s *Store) ensureFolder(ctx context.Context, parent *int64, name, rel string, depth int, generation int64) (int64, error) {
	key := pathKey(rel)
	var id int64
	err := s.db.QueryRowContext(ctx, `SELECT id FROM record_folder WHERE root_id=1 AND path_key=?`, key).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		res, err := s.db.ExecContext(ctx, `INSERT INTO record_folder(root_id,parent_id,name,relative_path,path_key,depth,last_seen_generation,last_scanned_at) VALUES(1,?,?,?,?,?,?,CURRENT_TIMESTAMP)`, nullableID(parent), name, rel, key, depth, generation)
		if err != nil {
			return 0, err
		}
		id, err = res.LastInsertId()
		return id, err
	}
	if err != nil {
		return 0, err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE record_folder SET parent_id=?, name=?, relative_path=?, depth=?, state='active', last_seen_generation=?, last_scanned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`, nullableID(parent), name, rel, depth, generation, id)
	return id, err
}

func nullableID(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func (s *Store) upsertAsset(ctx context.Context, folderID int64, name, rel, kind, mime string, info fs.FileInfo, generation int64) (int64, error) {
	var id int64
	key := pathKey(rel)
	err := s.db.QueryRowContext(ctx, `SELECT id FROM record_asset WHERE root_id=1 AND path_key=?`, key).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		res, err := s.db.ExecContext(ctx, `INSERT INTO record_asset(root_id,folder_id,name,relative_path,path_key,kind,extension,mime_type,size_bytes,mtime_ns,availability,last_seen_generation) VALUES(1,?,?,?,?,?,?,?,?,?,'available',?)`, folderID, name, rel, key, kind, strings.ToLower(filepath.Ext(name)), mime, info.Size(), info.ModTime().UnixNano(), generation)
		if err != nil {
			return 0, err
		}
		return res.LastInsertId()
	}
	if err != nil {
		return 0, err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE record_asset SET folder_id=?, name=?, relative_path=?, kind=?, extension=?, mime_type=?, size_bytes=?, mtime_ns=?, availability='available', last_seen_generation=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, folderID, name, rel, kind, strings.ToLower(filepath.Ext(name)), mime, info.Size(), info.ModTime().UnixNano(), generation, id)
	return id, err
}

func pathKey(rel string) string {
	clean := strings.TrimPrefix(filepath.ToSlash(filepath.Clean(rel)), "./")
	return norm.NFC.String(clean)
}

func classify(name string) (string, string) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts":
		return "video", mimeFor(name)
	case ".jpg", ".jpeg", ".png", ".webp", ".avif":
		return "image", mimeFor(name)
	case ".vtt", ".srt", ".ass", ".ssa":
		return "subtitle", mimeFor(name)
	case ".nfo", ".json", ".xml":
		return "metadata", mimeFor(name)
	default:
		return "other", mimeFor(name)
	}
}

func mimeFor(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	mapType := map[string]string{".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".m4v": "video/x-m4v", ".ts": "video/mp2t", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".vtt": "text/vtt", ".srt": "application/x-subrip", ".ass": "text/x-ssa", ".ssa": "text/x-ssa"}
	return mapType[ext]
}

func (s *Store) ListTree(ctx context.Context, parentID int64, limit int) ([]Folder, []Asset, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	if parentID <= 0 {
		if err := s.db.QueryRowContext(ctx, `SELECT id FROM record_folder WHERE root_id=1 AND path_key='.'`).Scan(&parentID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return []Folder{}, []Asset{}, nil
			}
			return nil, nil, err
		}
	}
	folderRows, err := s.db.QueryContext(ctx, `SELECT f.id, f.parent_id, f.name, f.relative_path, f.depth, (SELECT COUNT(*) FROM record_folder c WHERE c.parent_id=f.id AND c.state='active'), (SELECT COUNT(*) FROM record_asset a WHERE a.folder_id=f.id AND a.availability='available') FROM record_folder f WHERE f.parent_id=? AND f.state='active' ORDER BY f.name COLLATE NOCASE, f.id LIMIT ?`, parentID, limit)
	if err != nil {
		return nil, nil, err
	}
	defer folderRows.Close()
	folders := []Folder{}
	for folderRows.Next() {
		var f Folder
		if err := folderRows.Scan(&f.ID, &f.ParentID, &f.Name, &f.RelativePath, &f.Depth, &f.ChildCount, &f.AssetCount); err != nil {
			return nil, nil, err
		}
		f.Artwork = s.artworkForFolder(f)
		folders = append(folders, f)
	}
	assetRows, err := s.db.QueryContext(ctx, `SELECT id, folder_id, name, relative_path, kind, mime_type, size_bytes, duration_seconds, width, height, availability FROM record_asset WHERE folder_id=? AND availability='available' ORDER BY name COLLATE NOCASE, id LIMIT ?`, parentID, limit)
	if err != nil {
		return nil, nil, err
	}
	defer assetRows.Close()
	assets := []Asset{}
	for assetRows.Next() {
		var a Asset
		if err := assetRows.Scan(&a.ID, &a.FolderID, &a.Name, &a.RelativePath, &a.Kind, &a.MimeType, &a.SizeBytes, &a.DurationSeconds, &a.Width, &a.Height, &a.Availability); err != nil {
			return nil, nil, err
		}
		assets = append(assets, a)
	}
	return folders, assets, nil
}

func (s *Store) artworkForFolder(f Folder) Artwork {
	base := filepath.Join(s.root, filepath.FromSlash(f.RelativePath))
	_ = base // URLs are resolved by the HTTP layer through the folder id.
	return Artwork{}
}

func (s *Store) Asset(ctx context.Context, id int64) (Asset, error) {
	var a Asset
	err := s.db.QueryRowContext(ctx, `SELECT id,folder_id,name,relative_path,kind,mime_type,size_bytes,duration_seconds,width,height,availability FROM record_asset WHERE id=?`, id).Scan(&a.ID, &a.FolderID, &a.Name, &a.RelativePath, &a.Kind, &a.MimeType, &a.SizeBytes, &a.DurationSeconds, &a.Width, &a.Height, &a.Availability)
	return a, err
}

func (s *Store) AssetPath(ctx context.Context, id int64) (string, Asset, error) {
	a, err := s.Asset(ctx, id)
	if err != nil {
		return "", Asset{}, err
	}
	path, err := s.safePath(a.RelativePath)
	if err != nil {
		return "", Asset{}, err
	}
	return path, a, nil
}

func (s *Store) safePath(relative string) (string, error) {
	root := filepath.Clean(s.root)
	path := filepath.Clean(filepath.Join(root, filepath.FromSlash(relative)))
	if path != root && !strings.HasPrefix(path, root+string(filepath.Separator)) {
		return "", errors.New("record path escapes root")
	}
	parts, err := filepath.Rel(root, path)
	if err != nil {
		return "", err
	}
	current := root
	if parts != "." {
		for _, part := range strings.Split(parts, string(filepath.Separator)) {
			current = filepath.Join(current, part)
			info, err := os.Lstat(current)
			if err != nil {
				return "", err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return "", errors.New("record path contains a link")
			}
		}
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || (rel != "." && strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
		return "", errors.New("record path escapes root")
	}
	return path, nil
}

func (s *Store) ArtworkPath(ctx context.Context, folderID int64, role string) (string, Asset, error) {
	role = strings.ToLower(strings.TrimSpace(role))
	if role != "poster" && role != "backdrop" {
		return "", Asset{}, errors.New("invalid artwork role")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,folder_id,name,relative_path,kind,mime_type,size_bytes,duration_seconds,width,height,availability FROM record_asset WHERE folder_id=? AND kind='image' AND availability='available'`, folderID)
	if err != nil {
		return "", Asset{}, err
	}
	defer rows.Close()
	type candidate struct {
		a        Asset
		priority int
	}
	candidates := []candidate{}
	for rows.Next() {
		var a Asset
		if err := rows.Scan(&a.ID, &a.FolderID, &a.Name, &a.RelativePath, &a.Kind, &a.MimeType, &a.SizeBytes, &a.DurationSeconds, &a.Width, &a.Height, &a.Availability); err != nil {
			return "", Asset{}, err
		}
		stem := strings.TrimSuffix(strings.ToLower(a.Name), strings.ToLower(filepath.Ext(a.Name)))
		p := 0
		if role == "poster" {
			switch stem {
			case "folder":
				p = 1
			case "poster":
				p = 2
			case "cover":
				p = 3
			}
		} else {
			switch stem {
			case "backdrop":
				p = 1
			case "fanart":
				p = 2
			case "background":
				p = 3
			}
		}
		if p > 0 {
			candidates = append(candidates, candidate{a, p})
		}
	}
	if len(candidates) == 0 {
		return "", Asset{}, sql.ErrNoRows
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].priority != candidates[j].priority {
			return candidates[i].priority < candidates[j].priority
		}
		return candidates[i].a.Name < candidates[j].a.Name
	})
	path, _, err := s.AssetPath(ctx, candidates[0].a.ID)
	return path, candidates[0].a, err
}

func (s *Store) Progress(ctx context.Context, userID, assetID int64) (Progress, error) {
	var p Progress
	var last sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT position_seconds,duration_seconds,completed,last_played_at FROM record_asset_progress WHERE user_id=? AND asset_id=?`, userID, assetID).Scan(&p.PositionSeconds, &p.DurationSeconds, &p.Completed, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return Progress{}, nil
	}
	if last.Valid {
		p.LastPlayedAt = last.String
	}
	return p, err
}

func (s *Store) SaveProgress(ctx context.Context, userID, assetID int64, p Progress) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO record_asset_progress(user_id,asset_id,position_seconds,duration_seconds,completed,last_played_at,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(user_id,asset_id) DO UPDATE SET position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,completed=excluded.completed,last_played_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`, userID, assetID, p.PositionSeconds, p.DurationSeconds, p.Completed)
	return err
}

func ServeContent(w http.ResponseWriter, r *http.Request, path string, modTime time.Time) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("record asset is not a regular file")
	}
	http.ServeContent(w, r, filepath.Base(path), modTime, f)
	return nil
}

// ValidateImageFile accepts the passive raster formats that the record API
// serves inline. Classification remains extension-based for discovery, but a
// file must carry the matching container signature before it is rendered as
// artwork or an image preview.
func ValidateImageFile(path, mimeType string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := make([]byte, 512)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return err
	}
	buf = buf[:n]
	valid := false
	switch mimeType {
	case "image/jpeg":
		valid = len(buf) >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff
	case "image/png":
		valid = len(buf) >= 8 && string(buf[:8]) == "\x89PNG\r\n\x1a\n"
	case "image/webp":
		valid = len(buf) >= 12 && string(buf[:4]) == "RIFF" && string(buf[8:12]) == "WEBP"
	case "image/avif":
		valid = len(buf) >= 12 && string(buf[4:8]) == "ftyp" && (string(buf[8:12]) == "avif" || string(buf[8:12]) == "avis")
	}
	if !valid {
		return errors.New("record image signature does not match its declared type")
	}
	return nil
}
