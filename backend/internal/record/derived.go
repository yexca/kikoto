package record

import (
	"context"
	"database/sql"
	"path/filepath"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/naturalorder"
)

// Derived fields are what the store works out from the catalog for listings,
// so a listing reads no files and needs no reordering: each folder's and
// file's natural-order sort key and each folder's poster and backdrop. A scan
// keeps them current; derivedVersion records the collation the stored keys
// were computed with.

// derivedVersion changes whenever a stored sort key or artwork choice may
// change for the same catalog, so the store recomputes them all once.
const derivedVersion = naturalorder.KeyVersion

// Artwork roles name the image stems a folder's poster and backdrop are read
// from, in priority order.
var artworkStems = map[string][]string{
	"poster":   {"folder", "poster", "cover"},
	"backdrop": {"backdrop", "fanart", "background"},
}

// ensureDerived recomputes every derived field once when the stored ones were
// computed for another derivedVersion, as after an upgrade. Sort keys come
// from the catalog alone; artwork is chosen from the image files, so it waits
// until the root is online: an unmounted root reads as if every image were
// gone, and choosing then would clear every poster and backdrop. Until then
// the earlier choices stay and the stored version is left as it was.
func (s *Store) ensureDerived(ctx context.Context) error {
	s.derivedMu.Lock()
	defer s.derivedMu.Unlock()
	if s.derivedReady {
		return nil
	}
	var version int
	if err := s.db.QueryRowContext(ctx, `SELECT derived_version FROM record_root WHERE id=1`).Scan(&version); err != nil {
		return err
	}
	if version != derivedVersion {
		if !s.sortKeysReady {
			if err := s.refreshSortKeys(ctx); err != nil {
				return err
			}
			s.sortKeysReady = true
		}
		root, err := s.EnsureRoot(ctx)
		if err != nil {
			return err
		}
		if root.State != "online" {
			return nil
		}
		if err := s.refreshArtwork(ctx); err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE record_root SET derived_version=? WHERE id=1`, derivedVersion); err != nil {
			return err
		}
	}
	s.derivedReady = true
	return nil
}

// refreshSortKeys recomputes the sort key of every folder and file.
func (s *Store) refreshSortKeys(ctx context.Context) error {
	for _, table := range []string{"record_folder", "record_asset"} {
		rows, err := s.db.QueryContext(ctx, `SELECT id, name FROM `+table+` WHERE root_id=1`)
		if err != nil {
			return err
		}
		type row struct {
			id   int64
			name string
		}
		pending := []row{}
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.name); err != nil {
				_ = rows.Close()
				return err
			}
			pending = append(pending, r)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		for _, r := range pending {
			if _, err := tx.ExecContext(ctx, `UPDATE `+table+` SET sort_key=? WHERE id=?`, naturalorder.Key(r.name), r.id); err != nil {
				_ = tx.Rollback()
				return err
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// refreshArtwork chooses each active folder's poster and backdrop: for each
// role, the available image whose stem comes first in the role's list, by
// name among equals, that carries a valid image signature.
func (s *Store) refreshArtwork(ctx context.Context) error {
	return s.chooseArtwork(ctx, 0)
}

// refreshFolderArtwork chooses one folder's poster and backdrop again.
func (s *Store) refreshFolderArtwork(ctx context.Context, folderID int64) error {
	return s.chooseArtwork(ctx, folderID)
}

// chooseArtwork chooses the artwork of one folder, or of every folder when
// folderID is 0.
func (s *Store) chooseArtwork(ctx context.Context, folderID int64) error {
	rows, err := s.db.QueryContext(ctx, `SELECT a.id, a.folder_id, a.name, a.relative_path, a.mime_type
		FROM record_asset a JOIN record_folder f ON f.id=a.folder_id AND f.state='active'
		WHERE a.root_id=1 AND a.kind='image' AND a.availability='available' AND (?1=0 OR a.folder_id=?1)`, folderID)
	if err != nil {
		return err
	}
	type candidate struct {
		id                   int64
		name, relative, mime string
		priority             int
	}
	byFolder := map[int64]map[string][]candidate{}
	for rows.Next() {
		var c candidate
		var folderID int64
		if err := rows.Scan(&c.id, &folderID, &c.name, &c.relative, &c.mime); err != nil {
			_ = rows.Close()
			return err
		}
		stem := strings.ToLower(strings.TrimSuffix(c.name, filepath.Ext(c.name)))
		for role, stems := range artworkStems {
			for priority, wanted := range stems {
				if stem != wanted {
					continue
				}
				c.priority = priority
				if byFolder[folderID] == nil {
					byFolder[folderID] = map[string][]candidate{}
				}
				byFolder[folderID][role] = append(byFolder[folderID][role], c)
			}
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	type choice struct{ poster, backdrop sql.NullInt64 }
	choices := map[int64]choice{}
	for folderID, roles := range byFolder {
		var chosen choice
		for role, candidates := range roles {
			sort.Slice(candidates, func(i, j int) bool {
				if candidates[i].priority != candidates[j].priority {
					return candidates[i].priority < candidates[j].priority
				}
				return candidates[i].name < candidates[j].name
			})
			for _, c := range candidates {
				if err := ctx.Err(); err != nil {
					return err
				}
				path, err := s.safePath(c.relative)
				if err != nil || ValidateImageFile(path, c.mime) != nil {
					continue
				}
				if role == "poster" {
					chosen.poster = sql.NullInt64{Int64: c.id, Valid: true}
				} else {
					chosen.backdrop = sql.NullInt64{Int64: c.id, Valid: true}
				}
				break
			}
		}
		choices[folderID] = chosen
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE record_folder SET poster_asset_id=NULL, backdrop_asset_id=NULL
		WHERE root_id=1 AND (?1=0 OR id=?1) AND (poster_asset_id IS NOT NULL OR backdrop_asset_id IS NOT NULL)`, folderID); err != nil {
		return err
	}
	for folderID, chosen := range choices {
		if !chosen.poster.Valid && !chosen.backdrop.Valid {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE record_folder SET poster_asset_id=?, backdrop_asset_id=? WHERE id=?`, chosen.poster, chosen.backdrop, folderID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// folderColumns are the record_folder columns scanFolder reads, aliased as f,
// with the folder's artwork joined as pa and ba by folderArtworkJoins.
const folderColumns = `f.id, f.parent_id, f.name, f.relative_path, f.depth,
	(SELECT COUNT(*) FROM record_folder c WHERE c.parent_id=f.id AND c.state='active'),
	(SELECT COUNT(*) FROM record_asset a WHERE a.folder_id=f.id AND a.availability='available'),
	pa.id IS NOT NULL, ba.id IS NOT NULL`

const folderArtworkJoins = `LEFT JOIN record_asset pa ON pa.id=f.poster_asset_id AND pa.availability='available'
	LEFT JOIN record_asset ba ON ba.id=f.backdrop_asset_id AND ba.availability='available'`

func scanFolder(row rowScanner) (Folder, error) {
	var f Folder
	err := row.Scan(&f.ID, &f.ParentID, &f.Name, &f.RelativePath, &f.Depth, &f.ChildCount, &f.AssetCount, &f.HasPoster, &f.HasBackdrop)
	return f, err
}

// folderTrail lists the folders from the root's child down to folderID; the
// root itself, and a folder that is not recorded, have none.
func (s *Store) folderTrail(ctx context.Context, folderID int64) ([]Folder, error) {
	rows, err := s.db.QueryContext(ctx, `WITH RECURSIVE trail(id) AS (
			SELECT id FROM record_folder WHERE id=?
			UNION ALL
			SELECT f.parent_id FROM record_folder f JOIN trail t ON f.id=t.id WHERE f.parent_id IS NOT NULL
		)
		SELECT `+folderColumns+` FROM record_folder f `+folderArtworkJoins+`
		WHERE f.id IN (SELECT id FROM trail) AND f.depth > 0 ORDER BY f.depth`, folderID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	trail := []Folder{}
	for rows.Next() {
		f, err := scanFolder(rows)
		if err != nil {
			return nil, err
		}
		trail = append(trail, f)
	}
	return trail, rows.Err()
}
