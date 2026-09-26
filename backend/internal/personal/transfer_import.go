package personal

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"sort"
)

type ImportPreview struct {
	Works             int      `json:"works"`
	Playlists         int      `json:"playlists"`
	Tags              int      `json:"tags"`
	MatchedWorks      int      `json:"matchedWorks"`
	MissingCodes      []string `json:"missingCodes"`
	Conflicts         int      `json:"conflicts"`
	UnmatchedProgress int      `json:"unmatchedProgress"`
}

type ImportResult struct {
	ImportedWorks   int `json:"importedWorks"`
	SkippedWorks    int `json:"skippedWorks"`
	Playlists       int `json:"playlists"`
	Tags            int `json:"tags"`
	SkippedProgress int `json:"skippedProgress"`
}

type importPlan struct {
	preview   ImportPreview
	works     map[string]int64
	conflicts map[int64]bool
	media     map[string]int64
}

func resolveCode(ctx context.Context, tx *sql.Tx, code string) (int64, error) {
	var id int64
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(l.canonical_work_id,w.id) FROM work w LEFT JOIN work_edition e ON e.work_id=w.id LEFT JOIN logical_work l ON l.id=e.logical_work_id WHERE w.primary_code=?`, code).Scan(&id)
	if !errors.Is(err, sql.ErrNoRows) {
		return id, err
	}
	// Only unambiguous provider-declared aliases of existing works are accepted.
	var count int
	err = tx.QueryRowContext(ctx, `SELECT COUNT(DISTINCT w.id),COALESCE(MIN(w.id),0) FROM work_code_alias a JOIN logical_work l ON l.id=a.logical_work_id JOIN work w ON w.id=l.canonical_work_id WHERE UPPER(a.primary_code)=?`, code).Scan(&count, &id)
	if err != nil {
		return 0, err
	}
	if count != 1 {
		return 0, nil
	}
	return id, nil
}

func matchProgress(ctx context.Context, tx *sql.Tx, work int64, p *BackupProgress) (int64, error) {
	if p.MediaTitle == "" {
		return 0, nil
	}
	mediaWork, err := resolveCode(ctx, tx, p.MediaWorkCode)
	if err != nil || mediaWork != work {
		return 0, err
	}
	var id int64
	var count int
	// Never guess between duplicate file names or bind a foreign source-local id.
	err = tx.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(MIN(m.id),0) FROM media_item m JOIN work w ON w.id=m.work_id WHERE w.primary_code=? AND m.title=? AND m.kind IN ('audio','video') AND m.track_no IS ? AND m.disc_no IS ?`, p.MediaWorkCode, p.MediaTitle, p.TrackNumber, p.DiscNumber).Scan(&count, &id)
	if err != nil {
		return 0, err
	}
	if count != 1 {
		return 0, nil
	}
	return id, nil
}

func buildImportPlan(ctx context.Context, tx *sql.Tx, user int64, b Backup) (importPlan, error) {
	p := importPlan{preview: ImportPreview{Works: len(b.Works), Playlists: len(b.Playlists), Tags: len(b.Tags), MissingCodes: []string{}}, works: map[string]int64{}, conflicts: map[int64]bool{}, media: map[string]int64{}}
	codes := map[string]bool{}
	for _, w := range b.Works {
		codes[w.PrimaryCode] = true
	}
	for _, l := range b.Playlists {
		for _, i := range l.Items {
			codes[i.PrimaryCode] = true
		}
	}
	for code := range codes {
		id, err := resolveCode(ctx, tx, code)
		if err != nil {
			return p, err
		}
		p.works[code] = id
		if id == 0 {
			p.preview.MissingCodes = append(p.preview.MissingCodes, code)
		}
	}
	sort.Strings(p.preview.MissingCodes)
	seen := map[int64]bool{}
	for _, w := range b.Works {
		id := p.works[w.PrimaryCode]
		if id == 0 {
			continue
		}
		if seen[id] {
			return p, ErrConflict
		}
		seen[id] = true
		p.preview.MatchedWorks++
		var exists bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM user_work_state WHERE user_id=? AND work_id=?) OR EXISTS(SELECT 1 FROM user_work_tag WHERE user_id=? AND work_id=?) OR EXISTS(SELECT 1 FROM user_work_playback_cursor WHERE user_id=? AND work_id=?) OR EXISTS(SELECT 1 FROM user_listening_session WHERE user_id=? AND work_id=?) OR EXISTS(SELECT 1 FROM user_listening_import WHERE user_id=? AND work_id=?)`, user, id, user, id, user, id, user, id, user, id).Scan(&exists)
		if err != nil {
			return p, err
		}
		p.conflicts[id] = exists
		if exists {
			p.preview.Conflicts++
		}
		if w.Progress != nil {
			p.media[w.PrimaryCode], err = matchProgress(ctx, tx, id, w.Progress)
			if err != nil {
				return p, err
			}
			if p.media[w.PrimaryCode] == 0 {
				p.preview.UnmatchedProgress++
			}
		}
	}
	return p, nil
}

func (s Store) PreviewImport(ctx context.Context, user int64, b Backup) (ImportPreview, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ImportPreview{}, err
	}
	defer func() { _ = tx.Rollback() }()
	p, err := buildImportPlan(ctx, tx, user, b)
	return p.preview, err
}

func (s Store) Import(ctx context.Context, user int64, b Backup, overwrite bool) (ImportResult, error) {
	result := ImportResult{}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback() }()
	plan, err := buildImportPlan(ctx, tx, user, b)
	if err != nil {
		return result, err
	}
	for _, tag := range b.Tags {
		if _, err = importTag(ctx, tx, user, tag, overwrite); err != nil {
			return result, err
		}
		result.Tags++
	}
	for _, w := range b.Works {
		id := plan.works[w.PrimaryCode]
		if id == 0 || (plan.conflicts[id] && !overwrite) {
			result.SkippedWorks++
			continue
		}
		if err = importWork(ctx, tx, user, id, plan.media[w.PrimaryCode], w, overwrite); err != nil {
			return result, err
		}
		result.ImportedWorks++
		if w.Progress != nil && plan.media[w.PrimaryCode] == 0 {
			result.SkippedProgress++
		}
	}
	for _, list := range b.Playlists {
		changed, err := importPlaylist(ctx, tx, user, list, plan.works, overwrite)
		if err != nil {
			return result, err
		}
		if changed {
			result.Playlists++
		}
	}
	// Match the existing favorite-list contract: the bit is derived membership.
	_, err = tx.ExecContext(ctx, `UPDATE user_work_state SET favorite=EXISTS(SELECT 1 FROM favorite_list_item i JOIN favorite_list l ON l.id=i.list_id WHERE l.user_id=? AND l.kind='user' AND i.work_id=user_work_state.work_id) WHERE user_id=?`, user, user)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func importTag(ctx context.Context, tx *sql.Tx, user int64, tag BackupTag, overwrite bool) (int64, error) {
	t := tagScopes[tag.Scope]
	var id int64
	err := tx.QueryRowContext(ctx, `SELECT id FROM `+t.tags+` WHERE user_id=? AND LOWER(name)=LOWER(?) ORDER BY id LIMIT 1`, user, tag.Name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		result, err := tx.ExecContext(ctx, `INSERT INTO `+t.tags+` (user_id,name,color) VALUES (?,?,?)`, user, tag.Name, tag.Color)
		if err != nil {
			return 0, err
		}
		return result.LastInsertId()
	}
	if err == nil && overwrite {
		_, err = tx.ExecContext(ctx, `UPDATE `+t.tags+` SET color=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`, tag.Color, id, user)
	}
	return id, err
}

func importWork(ctx context.Context, tx *sql.Tx, user, id, media int64, w BackupWork, overwrite bool) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO user_work_state (user_id,work_id,listening_status,rating,note) VALUES (?,?,?,?,?) ON CONFLICT(user_id,work_id) DO UPDATE SET listening_status=excluded.listening_status,rating=excluded.rating,note=excluded.note,updated_at=CURRENT_TIMESTAMP`, user, id, w.ListeningStatus, w.Rating, w.Note)
	if err != nil {
		return err
	}
	if overwrite {
		if _, err = tx.ExecContext(ctx, `DELETE FROM user_work_tag WHERE user_id=? AND work_id=?`, user, id); err != nil {
			return err
		}
	}
	for _, name := range w.Tags {
		tag, err := importTag(ctx, tx, user, BackupTag{Scope: "work", Name: name}, false)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO user_work_tag (user_id,work_id,user_tag_id) VALUES (?,?,?) ON CONFLICT DO NOTHING`, user, id, tag); err != nil {
			return err
		}
	}
	if p := w.Progress; p != nil && media > 0 {
		_, err = tx.ExecContext(ctx, `INSERT INTO user_work_playback_cursor (user_id,work_id,media_item_id,position_seconds,duration_seconds,completed,last_played_at) VALUES (?,?,?,?,?,?,NULLIF(?,'')) ON CONFLICT(user_id,work_id) DO UPDATE SET media_item_id=excluded.media_item_id,file_source_id=NULL,location_id=NULL,location_type='',position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,completed=excluded.completed,last_played_at=excluded.last_played_at,updated_at=CURRENT_TIMESTAMP`, user, id, media, p.PositionSeconds, p.DurationSeconds, p.Completed, p.LastPlayedAt)
		if err != nil {
			return err
		}
	}
	if stats := w.Statistics; stats != nil {
		var seconds float64
		var count int64
		if err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(listened_seconds),0),COUNT(*) FROM user_listening_session WHERE user_id=? AND work_id=?`, user, id).Scan(&seconds, &count); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO user_listening_import (user_id,work_id,listened_seconds,listen_count,last_played_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,work_id) DO UPDATE SET listened_seconds=MAX(listened_seconds,excluded.listened_seconds),listen_count=MAX(listen_count,excluded.listen_count),last_played_at=MAX(last_played_at,excluded.last_played_at)`, user, id, math.Max(0, stats.ListenedSeconds-seconds), max(int64(0), stats.ListenCount-count), stats.LastPlayedAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func importPlaylist(ctx context.Context, tx *sql.Tx, user int64, list BackupPlaylist, works map[string]int64, overwrite bool) (bool, error) {
	var id int64
	err := tx.QueryRowContext(ctx, `SELECT id FROM favorite_list WHERE user_id=? AND name=? AND kind='user'`, user, list.Name).Scan(&id)
	if err == nil && !overwrite {
		return false, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		result, insertErr := tx.ExecContext(ctx, `INSERT INTO favorite_list (user_id,name,description,sort_order,kind) VALUES (?,?,?,?,'user')`, user, list.Name, list.Description, list.SortOrder)
		if insertErr != nil {
			return false, insertErr
		}
		id, err = result.LastInsertId()
	} else if err == nil {
		_, err = tx.ExecContext(ctx, `UPDATE favorite_list SET description=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`, list.Description, list.SortOrder, id, user)
		if err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM favorite_list_item WHERE list_id=?`, id)
		}
	}
	if err != nil {
		return false, err
	}
	for _, item := range list.Items {
		work := works[item.PrimaryCode]
		if work == 0 {
			continue
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO favorite_list_item (list_id,work_id,note,sort_order) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, id, work, item.Note, item.SortOrder); err != nil {
			return false, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO user_work_state (user_id,work_id,favorite) VALUES (?,?,1) ON CONFLICT(user_id,work_id) DO UPDATE SET favorite=1`, user, work); err != nil {
			return false, err
		}
	}
	return true, nil
}
