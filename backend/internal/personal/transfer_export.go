package personal

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

func scanRows(ctx context.Context, tx *sql.Tx, query string, args []any, scan func(*sql.Rows) error) error {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s Store) Export(ctx context.Context, user int64) ([]byte, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	b := Backup{Format: "kikoto-user-data", Version: 1, ExportedAt: time.Now().UTC().Format(time.RFC3339), Works: []BackupWork{}, Tags: []BackupTag{}, Playlists: []BackupPlaylist{}}
	// Stop while reading, before many large notes can accumulate in memory.
	// JSON framing and escaping are checked against the exact budget below.
	textBudget := MaxTransferBytes
	reserveText := func(values ...string) error {
		for _, value := range values {
			textBudget -= len(value)
		}
		if textBudget < 0 {
			return ErrLimit
		}
		return nil
	}
	workIndex := map[int64]int{}
	err = scanRows(ctx, tx, `WITH personal_work AS (
	 SELECT work_id FROM user_work_state WHERE user_id = ?
	 UNION SELECT work_id FROM user_work_tag WHERE user_id = ?
	 UNION SELECT work_id FROM user_work_playback_cursor WHERE user_id = ?
	 UNION SELECT work_id FROM user_listening_session WHERE user_id = ?
	 UNION SELECT work_id FROM user_listening_import WHERE user_id = ?
	 UNION SELECT i.work_id FROM favorite_list_item i JOIN favorite_list l ON l.id=i.list_id WHERE l.user_id = ? AND l.kind='user'
	) SELECT w.id,w.primary_code,COALESCE(s.listening_status,'none'),s.rating,COALESCE(s.note,'')
	FROM personal_work p JOIN work w ON w.id=p.work_id LEFT JOIN user_work_state s ON s.work_id=w.id AND s.user_id=? ORDER BY w.primary_code LIMIT ?`, []any{user, user, user, user, user, user, user, maxTransferWorks + 1}, func(rows *sql.Rows) error {
		var w BackupWork
		var id int64
		if err := rows.Scan(&id, &w.PrimaryCode, &w.ListeningStatus, &w.Rating, &w.Note); err != nil {
			return err
		}
		if err := reserveText(w.PrimaryCode, w.ListeningStatus, w.Note); err != nil {
			return err
		}
		if len(b.Works) >= maxTransferWorks {
			return ErrLimit
		}
		w.Tags = []string{}
		workIndex[id] = len(b.Works)
		b.Works = append(b.Works, w)
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, scope := range []string{"work", "circle", "voice"} {
		t := tagScopes[scope]
		err = scanRows(ctx, tx, `SELECT name,color FROM `+t.tags+` WHERE user_id=? ORDER BY LOWER(name),id LIMIT ?`, []any{user, maxTransferTags + 1}, func(rows *sql.Rows) error {
			tag := BackupTag{Scope: scope}
			if err := rows.Scan(&tag.Name, &tag.Color); err != nil {
				return err
			}
			if err := reserveText(tag.Scope, tag.Name, tag.Color); err != nil {
				return err
			}
			if len(b.Tags) >= maxTransferTags {
				return ErrLimit
			}
			b.Tags = append(b.Tags, tag)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	assignments := 0
	err = scanRows(ctx, tx, `SELECT a.work_id,t.name FROM user_work_tag a JOIN user_tag t ON t.id=a.user_tag_id AND t.user_id=a.user_id WHERE a.user_id=? ORDER BY t.name LIMIT ?`, []any{user, maxTransferItems + 1}, func(rows *sql.Rows) error {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return err
		}
		if err := reserveText(name); err != nil {
			return err
		}
		assignments++
		if assignments > maxTransferItems {
			return ErrLimit
		}
		if i, ok := workIndex[id]; ok {
			b.Works[i].Tags = append(b.Works[i].Tags, name)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = scanRows(ctx, tx, `SELECT c.work_id,w.primary_code,m.title,m.track_no,m.disc_no,c.position_seconds,c.duration_seconds,c.completed,COALESCE(c.last_played_at,'') FROM user_work_playback_cursor c JOIN media_item m ON m.id=c.media_item_id JOIN work w ON w.id=m.work_id WHERE c.user_id=?`, []any{user}, func(rows *sql.Rows) error {
		var id int64
		var p BackupProgress
		if err := rows.Scan(&id, &p.MediaWorkCode, &p.MediaTitle, &p.TrackNumber, &p.DiscNumber, &p.PositionSeconds, &p.DurationSeconds, &p.Completed, &p.LastPlayedAt); err != nil {
			return err
		}
		if err := reserveText(p.MediaWorkCode, p.MediaTitle, p.LastPlayedAt); err != nil {
			return err
		}
		if i, ok := workIndex[id]; ok {
			b.Works[i].Progress = &p
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = scanRows(ctx, tx, historyCTE+`SELECT work_id,listened_seconds,listen_count,last_played_at FROM history`, []any{user, user}, func(rows *sql.Rows) error {
		var id int64
		var stats BackupStatistics
		if err := rows.Scan(&id, &stats.ListenedSeconds, &stats.ListenCount, &stats.LastPlayedAt); err != nil {
			return err
		}
		if err := reserveText(stats.LastPlayedAt); err != nil {
			return err
		}
		if i, ok := workIndex[id]; ok {
			b.Works[i].Statistics = &stats
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	listIndex := map[int64]int{}
	err = scanRows(ctx, tx, `SELECT id,name,description,sort_order FROM favorite_list WHERE user_id=? AND kind='user' ORDER BY sort_order,id LIMIT ?`, []any{user, maxTransferLists + 1}, func(rows *sql.Rows) error {
		var id int64
		list := BackupPlaylist{Items: []BackupPlaylistItem{}}
		if err := rows.Scan(&id, &list.Name, &list.Description, &list.SortOrder); err != nil {
			return err
		}
		if err := reserveText(list.Name, list.Description); err != nil {
			return err
		}
		if len(b.Playlists) >= maxTransferLists {
			return ErrLimit
		}
		listIndex[id] = len(b.Playlists)
		b.Playlists = append(b.Playlists, list)
		return nil
	})
	if err != nil {
		return nil, err
	}
	items := 0
	err = scanRows(ctx, tx, `SELECT i.list_id,w.primary_code,i.note,i.sort_order FROM favorite_list_item i JOIN favorite_list l ON l.id=i.list_id JOIN work w ON w.id=i.work_id WHERE l.user_id=? AND l.kind='user' ORDER BY i.sort_order,i.id LIMIT ?`, []any{user, maxTransferItems + 1}, func(rows *sql.Rows) error {
		var id int64
		var item BackupPlaylistItem
		if err := rows.Scan(&id, &item.PrimaryCode, &item.Note, &item.SortOrder); err != nil {
			return err
		}
		if err := reserveText(item.PrimaryCode, item.Note); err != nil {
			return err
		}
		items++
		if items > maxTransferItems {
			return ErrLimit
		}
		if i, ok := listIndex[id]; ok {
			b.Playlists[i].Items = append(b.Playlists[i].Items, item)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(b)
	if len(data) > MaxTransferBytes {
		return nil, ErrLimit
	}
	return data, err
}
