package metasync

import (
	"context"
	"database/sql"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
)

// ProcessMetadataTagQueue commits at most limit works atomically. Selection,
// projection and acknowledgement share the write transaction, so concurrent
// edits cannot lose a wakeup. A failed or cancelled batch remains durable.
func ProcessMetadataTagQueue(ctx context.Context, db *sql.DB, limit int, priorities []string) (count int, err error) {
	if limit <= 0 {
		return 0, nil
	}
	limit = min(limit, 64)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	defer func() {
		if err != nil && ctx.Err() != nil {
			err = ctx.Err()
		}
	}()
	tx, release, err := storage.BeginBoundedTx(ctx, db)
	if err != nil {
		return 0, err
	}
	defer release()
	rows, err := tx.QueryContext(ctx, "SELECT work_id FROM work_metadata_tag_dirty ORDER BY work_id LIMIT ?", limit)
	if err != nil {
		return 0, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return 0, err
	}
	if closeErr != nil {
		return 0, closeErr
	}
	for _, id := range ids {
		if err := ProjectWorkMetadataTagsTx(ctx, tx, id, priorities); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(ids), nil
}
