// Package record owns the independent local video and image library.
// Record assets are deliberately not works and never enter the audio library
// identity model.
package record

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/naturalorder"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"golang.org/x/text/unicode/norm"
)

const markerName = ".kikoto-record"

var ignoredNames = map[string]bool{
	markerName: true, markerName + ".tmp": true, ".kikoto-staging": true, ".kikoto-backup": true,
	".kikoto-trash": true, "@eaDir": true, "__MACOSX": true,
	"#recycle": true, ".DS_Store": true, "Thumbs.db": true,
}

// IgnoredName reports whether a scan skips every file or folder of this name,
// such as the root marker, its trash, and NAS or desktop metadata.
func IgnoredName(name string) bool { return ignoredNames[name] }

type Store struct {
	db    *sqlutil.DB
	root  string
	probe ProbeFunc
	// catalog holds one token, taken by whatever reads the disk into the
	// catalog or changes what the disk holds: a scan's walk, an
	// initialization, a marker restore, and a move to the trash.
	catalog chan struct{}
	// derivedReady records that the stored derived fields match derivedVersion;
	// sortKeysReady that the sort keys do while the artwork waits for the root.
	derivedMu     sync.Mutex
	derivedReady  bool
	sortKeysReady bool
}

// Option configures a Store.
type Option func(*Store)

// WithProber sets how ProbePending and ProbeIfPending read a file's details.
// Without one, every file stays pending.
func WithProber(probe ProbeFunc) Option { return func(s *Store) { s.probe = probe } }

func NewStore(db *sqlutil.DB, root string, options ...Option) *Store {
	store := &Store{db: db, root: root, catalog: make(chan struct{}, 1)}
	for _, option := range options {
		option(store)
	}
	return store
}

// lockCatalog waits for the catalog token, or for ctx to end.
func (s *Store) lockCatalog(ctx context.Context) (func(), error) {
	select {
	case s.catalog <- struct{}{}:
		return func() { <-s.catalog }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

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
	// HasPoster and HasBackdrop report the artwork a scan chose for the
	// folder; the HTTP layer names its URLs.
	HasPoster   bool `json:"-"`
	HasBackdrop bool `json:"-"`
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
	ThumbnailURL    string   `json:"thumbnailUrl,omitempty"`
	DownloadURL     string   `json:"downloadUrl,omitempty"`
	// Progress is the viewer's saved position for a video or audio file, when
	// there is one.
	Progress *Progress `json:"progress,omitempty"`
	// MtimeNs and the size identify the file revision a thumbnail belongs to.
	MtimeNs *int64 `json:"-"`
	// HasCover reports cover art embedded in an audio file, which becomes its
	// thumbnail.
	HasCover bool `json:"-"`
	// ProbePending marks a video or audio file whose media details are still
	// to be read, so its length and, for audio, its cover art are unknown.
	ProbePending bool `json:"-"`
	// Subtitle is a video's same-name WebVTT or SubRip sidecar, when the
	// listing pairs one.
	Subtitle *Asset `json:"subtitle,omitempty"`
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
	// PendingProbes counts the available videos and audio files whose length
	// is still to be read after the scan.
	PendingProbes int `json:"pendingProbes"`
	// ThumbnailsRemoved counts the cached thumbnails removed after a complete
	// scan because their assets are no longer available videos or images.
	ThumbnailsRemoved int `json:"thumbnailsRemoved,omitempty"`
}

type Progress struct {
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds,omitempty"`
	Completed       bool     `json:"completed"`
	LastPlayedAt    string   `json:"lastPlayedAt,omitempty"`
	// Order is when the client captured the progress, in Unix milliseconds,
	// increasing for each save; it is written, never read back.
	Order int64 `json:"-"`
}

func (s *Store) EnsureRoot(ctx context.Context) (Root, error) {
	path := filepath.Clean(strings.TrimSpace(s.root))
	if path == "." || path == "" {
		return Root{ID: 1, DisplayName: "Records", State: "unconfigured"}, nil
	}
	var expectedMarker string
	if err := s.db.QueryRowContext(ctx, `SELECT marker_id FROM record_root WHERE id=1`).Scan(&expectedMarker); err != nil {
		return Root{}, err
	}
	// Scans and the API act on the recorded state, so a state that cannot be
	// recorded is an error, never the earlier state read back, such as online
	// for a disk that was just unmounted.
	setState := func(state string) (Root, error) {
		if _, err := s.db.ExecContext(ctx, `UPDATE record_root SET configured_path=?, state=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`, path, state); err != nil {
			return Root{}, err
		}
		return s.rootRecord(ctx)
	}
	if info, err := os.Stat(path); err != nil {
		// A root the database initialized is unmounted while its path is
		// gone; only a root never initialized waits for initialization.
		state := "offline"
		if errors.Is(err, os.ErrNotExist) && expectedMarker == "" {
			state = "unconfigured"
		}
		return setState(state)
	} else if !info.IsDir() {
		return setState("unreadable")
	}
	markerID, found, err := readMarker(path)
	switch {
	case errors.Is(err, errInvalidMarker):
		return setState("offline")
	case err != nil:
		// A marker that cannot be read proves nothing about the disk.
		return setState("offline")
	case expectedMarker == "":
		// A database that never initialized this root waits for an explicit
		// initialization.
		return setState("unconfigured")
	case !found:
		// The path is there but its marker is not.
		// Nothing proves the disk is the one the catalog describes, but
		// nothing proves it is another either: the catalog is kept, users
		// browse and play it, a scan adds files without marking any missing,
		// and an administrator restores the marker.
		return setState(RootStateMarkerMissing)
	case markerID != expectedMarker:
		// Another initialized disk mounted at the same path is not this root.
		return setState("offline")
	}
	return setState("online")
}

// markerVersion starts every marker; the root's identity follows it.
const markerVersion = "kikoto-record-v1"

// markerMaxBytes bounds the marker read.
const markerMaxBytes = 256

var errInvalidMarker = errors.New("record root marker is invalid")

// readMarker returns the identity in the root's marker. found is false when
// there is no marker. A link, a non-regular file, an oversized file, or
// content other than the version and one identity is errInvalidMarker.
func readMarker(root string) (id string, found bool, err error) {
	path := filepath.Join(root, markerName)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() || info.Size() > markerMaxBytes {
		return "", true, errInvalidMarker
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", true, err
	}
	fields := strings.Fields(string(content))
	if len(fields) != 2 || fields[0] != markerVersion {
		return "", true, errInvalidMarker
	}
	return fields[1], true, nil
}

// writeMarker records id in the root's marker. The marker is written beside
// its final name and renamed into place, so a reader sees a whole marker.
func writeMarker(root, id string) error {
	temporary := filepath.Join(root, markerName+".tmp")
	if err := os.WriteFile(temporary, []byte(markerVersion+" "+id+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.Rename(temporary, filepath.Join(root, markerName)); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func newMarkerID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

// RootStateMarkerMissing is a root whose path exists without the marker, or
// the marker identity, of the catalog the database keeps.
const RootStateMarkerMissing = "marker_missing"

// ErrRootFreshRequired refuses to initialize a root whose database keeps a
// catalog the root's marker does not name, as when the marker is gone, the
// path is gone, or another disk is mounted there: only an explicit fresh
// initialization forgets a known catalog.
var ErrRootFreshRequired = errors.New("record root keeps a catalog; restore its marker or start a new catalog")

// ErrRootNotRecognized refuses to restore the marker of a root none of whose
// recorded folders or files is on disk, such as an unmounted, empty mount
// point.
var ErrRootNotRecognized = errors.New("record root holds none of the catalog's folders or files")

// ErrRootPathMissing refuses a fresh initialization while the database keeps
// a catalog and the root's path is gone, as when its disk is unmounted: the
// new catalog would be made where the disk is not.
var ErrRootPathMissing = errors.New("record root path is missing")

// ErrRootEmpty refuses a fresh initialization while the database keeps a
// catalog of folders or files and the root's path is an empty folder without
// a marker. That is what an unmounted disk leaves at its mount point, and a
// new catalog there would forget everyone's progress and states for files the
// disk still holds.
var ErrRootEmpty = errors.New("record root is an empty folder")

// RestoreMarker writes the marker again with the identity of the catalog the
// database keeps, for a root whose marker is missing. The catalog is kept.
func (s *Store) RestoreMarker(ctx context.Context) (Root, error) {
	unlock, err := s.lockCatalog(ctx)
	if err != nil {
		return Root{}, err
	}
	defer unlock()
	root, err := s.EnsureRoot(ctx)
	if err != nil {
		return Root{}, err
	}
	if root.State != RootStateMarkerMissing {
		return Root{}, errors.New("record root marker is not missing")
	}
	if recognized, err := s.rootHoldsCatalog(ctx); err != nil {
		return Root{}, err
	} else if !recognized {
		return Root{}, ErrRootNotRecognized
	}
	var id string
	if err := s.db.QueryRowContext(ctx, `SELECT marker_id FROM record_root WHERE id=1`).Scan(&id); err != nil {
		return Root{}, err
	}
	if err := writeMarker(filepath.Clean(strings.TrimSpace(s.root)), id); err != nil {
		return Root{}, err
	}
	return s.EnsureRoot(ctx)
}

// emptyRootKeepsCatalog reports whether path is a folder without a marker
// that holds nothing but the names a scan ignores, while the catalog records
// some folder or file.
func (s *Store) emptyRootKeepsCatalog(ctx context.Context, path string) (bool, error) {
	if _, found, err := readMarker(path); err != nil || found {
		return false, nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if !ignoredNames[entry.Name()] {
			return false, nil
		}
	}
	var recorded bool
	err = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM record_folder WHERE root_id=1 AND depth > 0)
		OR EXISTS(SELECT 1 FROM record_asset WHERE root_id=1)`).Scan(&recorded)
	return recorded, err
}

// rootHoldsCatalog reports whether some recorded folder or file of the
// catalog is on disk at the root, or the catalog records none.
func (s *Store) rootHoldsCatalog(ctx context.Context) (bool, error) {
	base := filepath.Clean(strings.TrimSpace(s.root))
	rows, err := s.db.QueryContext(ctx, `
		SELECT relative_path FROM record_folder WHERE root_id=1 AND depth > 0 AND state='active'
		UNION ALL
		SELECT relative_path FROM record_asset WHERE root_id=1 AND availability='available'
		LIMIT 200
	`)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	recorded := false
	for rows.Next() {
		var relative string
		if err := rows.Scan(&relative); err != nil {
			return false, err
		}
		recorded = true
		if _, err := os.Lstat(filepath.Join(base, filepath.FromSlash(relative))); err == nil {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return !recorded, nil
}

// InitializeRoot is an explicit administrator action. Scanning never creates
// a marker because an empty mount point must not be mistaken for a library.
// A new marker carries an identity of its own, so another initialized disk
// mounted at the same path is reported offline rather than taken for this
// root. Initializing a root whose marker already carries an identity adopts
// it. Adopting an identity other than the one the database keeps starts a
// new catalog: the folders, files, progress, and
// states recorded for the earlier identity describe another disk, so they are
// forgotten rather than matched to this root's files by path. Forgetting a
// catalog the database keeps takes an explicit fresh initialization: without
// fresh, a root whose marker does not name the kept catalog, whether the
// marker or the path is gone or another disk is mounted there, is refused
// with ErrRootFreshRequired. A fresh initialization still needs the path to
// exist while a catalog is kept, or it is refused with ErrRootPathMissing, and
// a path that is an empty folder without a marker while the catalog records
// folders or files is refused with ErrRootEmpty.
func (s *Store) InitializeRoot(ctx context.Context, fresh bool) (Root, error) {
	path := filepath.Clean(strings.TrimSpace(s.root))
	if path == "." || path == "" {
		return Root{}, errors.New("record root is not configured")
	}
	unlock, err := s.lockCatalog(ctx)
	if err != nil {
		return Root{}, err
	}
	defer unlock()
	var kept string
	if err := s.db.QueryRowContext(ctx, `SELECT marker_id FROM record_root WHERE id=1`).Scan(&kept); err != nil {
		return Root{}, err
	}
	if fresh && kept != "" {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return Root{}, ErrRootPathMissing
		}
		if empty, err := s.emptyRootKeepsCatalog(ctx, path); err != nil {
			return Root{}, err
		} else if empty {
			return Root{}, ErrRootEmpty
		}
	}
	if !fresh {
		if kept != "" {
			marker, _, err := readMarker(path)
			if err != nil && !errors.Is(err, os.ErrNotExist) || marker != kept {
				return Root{}, ErrRootFreshRequired
			}
		}
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return Root{}, err
	}
	id, found, err := readMarker(path)
	if err != nil {
		return Root{}, err
	}
	if !found {
		if id, err = newMarkerID(); err != nil {
			return Root{}, err
		}
		if err := writeMarker(path, id); err != nil {
			return Root{}, err
		}
	}
	if err := s.adoptRootIdentity(ctx, path, id); err != nil {
		return Root{}, err
	}
	return s.rootRecord(ctx)
}

// adoptRootIdentity records the root's path and identity, forgetting the
// catalog of an earlier identity in the same transaction.
func (s *Store) adoptRootIdentity(ctx context.Context, path, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var previous string
	if err := tx.QueryRowContext(ctx, `SELECT marker_id FROM record_root WHERE id=1`).Scan(&previous); err != nil {
		return err
	}
	statements := []string{}
	if previous != "" && previous != id {
		statements = append(statements,
			`DELETE FROM record_asset_progress WHERE asset_id IN (SELECT id FROM record_asset WHERE root_id=1)`,
			`DELETE FROM record_asset_state WHERE asset_id IN (SELECT id FROM record_asset WHERE root_id=1)`,
			`DELETE FROM record_asset WHERE root_id=1`,
			`DELETE FROM record_folder WHERE root_id=1`,
			`UPDATE record_root SET last_scan_run_id=NULL, last_scanned_at=NULL WHERE id=1`,
		)
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE record_root SET configured_path=?, marker_id=?, state='online', updated_at=CURRENT_TIMESTAMP WHERE id=1`, path, id); err != nil {
		return err
	}
	return tx.Commit()
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

// ScanProgress reports a walk in progress: the folders and files found so far.
type ScanProgress func(folders, assets int)

// Scan walks the root into the catalog and records the scan as finished. It
// reads no file's contents: ProbePending reads the length of the files the
// walk found new or changed.
func (s *Store) Scan(ctx context.Context) (ScanResult, error) {
	return s.ScanReporting(ctx, nil)
}

// ScanReporting is Scan that reports the walk's progress to progress after
// each folder and file it records.
func (s *Store) ScanReporting(ctx context.Context, progress ScanProgress) (ScanResult, error) {
	result, err := s.scanCatalog(ctx, progress)
	if err != nil || result.State != "complete" && result.State != "partial" {
		return result, err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE record_root SET last_scanned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=1`); err != nil {
		return ScanResult{}, err
	}
	if result.PendingProbes, err = s.PendingProbes(ctx, nil); err != nil {
		return ScanResult{}, err
	}
	return result, nil
}

// scanCatalog walks the root into the catalog under the catalog lock.
func (s *Store) scanCatalog(ctx context.Context, progress ScanProgress) (ScanResult, error) {
	unlock, err := s.lockCatalog(ctx)
	if err != nil {
		return ScanResult{}, err
	}
	defer unlock()
	root, err := s.EnsureRoot(ctx)
	if err != nil {
		return ScanResult{}, err
	}
	if root.State != "online" && root.State != RootStateMarkerMissing {
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
			if progress != nil {
				progress(folders, assets)
			}
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
		if progress != nil {
			progress(folders, assets)
		}
		return nil
	})
	if walkErr != nil && walkErr != filepath.SkipDir {
		unreadable++
	}
	if errors.Is(walkErr, context.Canceled) || errors.Is(walkErr, context.DeadlineExceeded) {
		return ScanResult{}, walkErr
	}
	// A disk unmounted after its marker was read leaves a mount point that
	// walks without errors, so the marker is read again before anything the
	// walk did not see is marked missing.
	unmounted := root.State == "online" && !s.markerStillNamesCatalog(ctx, base)
	if unmounted {
		unreadable++
	}
	complete := walkErr == nil && unreadable == 0
	// Without its marker the root may not be the disk the catalog describes,
	// so the scan adds and updates what it finds and marks nothing missing.
	markMissing := complete && root.State == "online"
	if markMissing {
		if _, err := s.db.ExecContext(ctx, `UPDATE record_folder SET state=CASE WHEN last_seen_generation=? THEN 'active' ELSE 'missing' END, updated_at=CURRENT_TIMESTAMP WHERE root_id=1`, generation); err != nil {
			return ScanResult{}, err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE record_asset SET availability=CASE WHEN last_seen_generation=? THEN 'available' ELSE 'missing' END, updated_at=CURRENT_TIMESTAMP WHERE root_id=1`, generation); err != nil {
			return ScanResult{}, err
		}
	}
	if err := s.ensureDerived(ctx); err != nil {
		return ScanResult{}, err
	}
	// The images of a root that went away read as gone, and a root without its
	// marker may be the empty mount point an unmounted disk leaves, so artwork
	// is chosen only while the marker names the catalog; the choices stay.
	if root.State == "online" && !unmounted {
		if err := s.refreshArtwork(ctx); err != nil {
			return ScanResult{}, err
		}
	}
	state := "complete"
	if !complete {
		state = "partial"
	}
	return ScanResult{RootID: root.ID, State: state, Folders: folders, Assets: assets, Unreadable: unreadable, MissingMarked: markMissing}, nil
}

// markerStillNamesCatalog reports whether the root's marker still carries the
// identity of the catalog the database keeps.
func (s *Store) markerStillNamesCatalog(ctx context.Context, base string) bool {
	var expected string
	if err := s.db.QueryRowContext(ctx, `SELECT marker_id FROM record_root WHERE id=1`).Scan(&expected); err != nil || expected == "" {
		return false
	}
	id, found, err := readMarker(base)
	return err == nil && found && id == expected
}

func (s *Store) ensureFolder(ctx context.Context, parent *int64, name, rel string, depth int, generation int64) (int64, error) {
	key := pathKey(rel)
	var id int64
	err := s.db.QueryRowContext(ctx, `SELECT id FROM record_folder WHERE root_id=1 AND path_key=?`, key).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		res, err := s.db.ExecContext(ctx, `INSERT INTO record_folder(root_id,parent_id,name,sort_key,relative_path,path_key,depth,last_seen_generation,last_scanned_at) VALUES(1,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`, nullableInt64Pointer(parent), name, naturalorder.Key(name), rel, key, depth, generation)
		if err != nil {
			return 0, err
		}
		id, err = res.LastInsertId()
		return id, err
	}
	if err != nil {
		return 0, err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE record_folder SET parent_id=?, name=?, sort_key=?, relative_path=?, depth=?, state='active', last_seen_generation=?, last_scanned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`, nullableInt64Pointer(parent), name, naturalorder.Key(name), rel, depth, generation, id)
	return id, err
}

// nullableInt64Pointer binds a nil pointer as SQL NULL and any other id as is.
func nullableInt64Pointer(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

// upsertAsset records a file the walk found and reports whether its media
// details became stale: the file is new, or its size, modification time, or
// kind changed.
func (s *Store) upsertAsset(ctx context.Context, folderID int64, name, rel, kind, mime string, info fs.FileInfo, generation int64) (bool, error) {
	var id int64
	var storedSize, storedMtime sql.NullInt64
	var storedKind string
	key := pathKey(rel)
	err := s.db.QueryRowContext(ctx, `SELECT id, size_bytes, mtime_ns, kind FROM record_asset WHERE root_id=1 AND path_key=?`, key).Scan(&id, &storedSize, &storedMtime, &storedKind)
	if errors.Is(err, sql.ErrNoRows) {
		_, err := s.db.ExecContext(ctx, `INSERT INTO record_asset(root_id,folder_id,name,sort_key,relative_path,path_key,kind,extension,mime_type,size_bytes,mtime_ns,availability,last_seen_generation) VALUES(1,?,?,?,?,?,?,?,?,?,?,'available',?)`, folderID, name, naturalorder.Key(name), rel, key, kind, strings.ToLower(filepath.Ext(name)), mime, info.Size(), info.ModTime().UnixNano(), generation)
		return err == nil, err
	}
	if err != nil {
		return false, err
	}
	// A changed size, modification time, or kind makes the earlier probe stale.
	// SQLite evaluates every SET expression against the row before the update.
	size, mtime := info.Size(), info.ModTime().UnixNano()
	stale := !storedSize.Valid || storedSize.Int64 != size || !storedMtime.Valid || storedMtime.Int64 != mtime || storedKind != kind
	_, err = s.db.ExecContext(ctx, `UPDATE record_asset SET
		probe_state=CASE WHEN size_bytes IS ? AND mtime_ns IS ? AND kind=? THEN probe_state ELSE 'pending' END,
		duration_seconds=CASE WHEN size_bytes IS ? AND mtime_ns IS ? AND kind=? THEN duration_seconds ELSE NULL END,
		width=CASE WHEN size_bytes IS ? AND mtime_ns IS ? AND kind=? THEN width ELSE NULL END,
		height=CASE WHEN size_bytes IS ? AND mtime_ns IS ? AND kind=? THEN height ELSE NULL END,
		has_cover=CASE WHEN size_bytes IS ? AND mtime_ns IS ? AND kind=? THEN has_cover ELSE NULL END,
		folder_id=?, name=?, sort_key=?, relative_path=?, kind=?, extension=?, mime_type=?, size_bytes=?, mtime_ns=?, availability='available', last_seen_generation=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		size, mtime, kind, size, mtime, kind, size, mtime, kind, size, mtime, kind, size, mtime, kind,
		folderID, name, naturalorder.Key(name), rel, kind, strings.ToLower(filepath.Ext(name)), mime, size, mtime, generation, id)
	return stale && err == nil, err
}

func pathKey(rel string) string {
	clean := strings.TrimPrefix(filepath.ToSlash(filepath.Clean(rel)), "./")
	return norm.NFC.String(clean)
}

func classify(name string) (string, string) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts":
		return "video", mimeFor(name)
	case ".mp3", ".m4a", ".flac", ".wav", ".wma", ".ogg", ".oga", ".opus", ".aac", ".aiff", ".aif", ".mka":
		return "audio", mimeFor(name)
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
	mapType := map[string]string{".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".m4v": "video/x-m4v", ".ts": "video/mp2t", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".wav": "audio/wav", ".wma": "audio/x-ms-wma", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac", ".aiff": "audio/aiff", ".aif": "audio/aiff", ".mka": "audio/x-matroska", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".vtt": "text/vtt", ".srt": "application/x-subrip", ".ass": "text/x-ssa", ".ssa": "text/x-ssa"}
	return mapType[ext]
}

// assetColumns are the record_asset columns scanAsset reads, aliased as a.
const assetColumns = `a.id, a.folder_id, a.name, a.relative_path, a.kind, a.mime_type, a.size_bytes, a.mtime_ns, a.duration_seconds, a.width, a.height, a.availability, a.has_cover, a.probe_state`

type rowScanner interface{ Scan(dest ...any) error }

func scanAsset(row rowScanner, extra ...any) (Asset, error) {
	var a Asset
	var hasCover sql.NullInt64
	var probeState string
	dest := append([]any{&a.ID, &a.FolderID, &a.Name, &a.RelativePath, &a.Kind, &a.MimeType, &a.SizeBytes, &a.MtimeNs, &a.DurationSeconds, &a.Width, &a.Height, &a.Availability, &hasCover, &probeState}, extra...)
	err := row.Scan(dest...)
	a.HasCover = hasCover.Valid && hasCover.Int64 == 1
	a.ProbePending = probeState == "pending" && (a.Kind == "video" || a.Kind == "audio")
	return a, err
}

// progressColumns are the record_asset_progress columns, aliased as p, that
// scanProgress reads after a LEFT JOIN.
const progressColumns = `p.position_seconds, p.duration_seconds, p.completed, p.last_played_at`

type progressFields struct {
	position   sql.NullFloat64
	duration   sql.NullFloat64
	completed  sql.NullBool
	lastPlayed sql.NullString
}

func (f *progressFields) dest() []any {
	return []any{&f.position, &f.duration, &f.completed, &f.lastPlayed}
}

func (f *progressFields) progress() *Progress {
	if !f.position.Valid {
		return nil
	}
	p := &Progress{PositionSeconds: f.position.Float64, Completed: f.completed.Bool, LastPlayedAt: f.lastPlayed.String}
	if f.duration.Valid {
		duration := f.duration.Float64
		p.DurationSeconds = &duration
	}
	return p
}

// ContinueLimitMax bounds the Continue watching list.
const ContinueLimitMax = 50

// ContinueWatching lists userID's most recently played available videos and
// audio files that stopped part way: past the first five seconds and not within five seconds
// of the end.
func (s *Store) ContinueWatching(ctx context.Context, userID int64, limit int) ([]Asset, error) {
	if limit <= 0 || limit > ContinueLimitMax {
		limit = 12
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+assetColumns+`, `+progressColumns+`
		FROM record_asset_progress p
		JOIN record_asset a ON a.id=p.asset_id
		JOIN record_folder f ON f.id=a.folder_id AND f.state='active'
		WHERE p.user_id=? AND p.completed=0 AND p.position_seconds>=5
			AND (p.duration_seconds IS NULL OR p.position_seconds < p.duration_seconds-5)
			AND a.kind IN ('video','audio') AND a.availability='available'
		ORDER BY p.last_played_at DESC, a.id DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	assets := []Asset{}
	for rows.Next() {
		var progress progressFields
		a, err := scanAsset(rows, progress.dest()...)
		if err != nil {
			return nil, err
		}
		a.Progress = progress.progress()
		assets = append(assets, a)
	}
	return assets, rows.Err()
}

func (s *Store) Asset(ctx context.Context, id int64) (Asset, error) {
	return scanAsset(s.db.QueryRowContext(ctx, `SELECT `+assetColumns+` FROM record_asset a WHERE a.id=?`, id))
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

// ArtworkPath returns the image a scan chose as the folder's poster or
// backdrop, while it is available.
func (s *Store) ArtworkPath(ctx context.Context, folderID int64, role string) (string, Asset, error) {
	column := map[string]string{"poster": "poster_asset_id", "backdrop": "backdrop_asset_id"}[strings.ToLower(strings.TrimSpace(role))]
	if column == "" {
		return "", Asset{}, errors.New("invalid artwork role")
	}
	if err := s.ensureDerived(ctx); err != nil {
		return "", Asset{}, err
	}
	a, err := scanAsset(s.db.QueryRowContext(ctx, `SELECT `+assetColumns+` FROM record_folder f JOIN record_asset a ON a.id=f.`+column+` WHERE f.id=? AND a.kind='image' AND a.availability='available'`, folderID))
	if err != nil {
		return "", Asset{}, err
	}
	path, err := s.safePath(a.RelativePath)
	return path, a, err
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

// SaveProgress stores a progress save unless the stored one is later in the
// client's order, so a save that arrives late never replaces a later
// position. It reports whether the save was stored.
func (s *Store) SaveProgress(ctx context.Context, userID, assetID int64, p Progress) (bool, error) {
	result, err := s.db.ExecContext(ctx, `INSERT INTO record_asset_progress(user_id,asset_id,position_seconds,duration_seconds,completed,last_played_at,updated_at,report_order) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?) ON CONFLICT(user_id,asset_id) DO UPDATE SET position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,completed=excluded.completed,last_played_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,report_order=excluded.report_order WHERE excluded.report_order>record_asset_progress.report_order`, userID, assetID, p.PositionSeconds, p.DurationSeconds, p.Completed, p.Order)
	if err != nil {
		return false, err
	}
	stored, err := result.RowsAffected()
	return stored > 0, err
}

func ServeContent(w http.ResponseWriter, r *http.Request, path string, modTime time.Time) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
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

// ThumbnailAssetIDs returns the available videos, images, and audio files with
// cover art: the assets that may keep cached thumbnails.
func (s *Store) ThumbnailAssetIDs(ctx context.Context) (map[int64]struct{}, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM record_asset WHERE root_id=1 AND availability='available' AND (kind IN ('video','image') OR (kind='audio' AND has_cover=1))`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := map[int64]struct{}{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids[id] = struct{}{}
	}
	return ids, rows.Err()
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
	defer func() { _ = f.Close() }()
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
