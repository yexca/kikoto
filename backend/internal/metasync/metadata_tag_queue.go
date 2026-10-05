package metasync

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
)

// ProcessMetadataTagQueue commits at most limit works atomically. Selection,
// projection and acknowledgement share the write transaction, so concurrent
// edits cannot lose a wakeup. A failed or cancelled batch remains durable.
func ProcessMetadataTagQueue(ctx context.Context, db *sql.DB, limit int, priorities []string) (count int, err error) {
	return processMetadataTagQueue(ctx, db, limit, priorities, time.Now(), 5*time.Second)
}

type metadataTagQueueWorkError struct {
	workID int64
	err    error
}

func (e *metadataTagQueueWorkError) Error() string {
	return fmt.Sprintf("project metadata tags for work %d: %v", e.workID, e.err)
}
func (e *metadataTagQueueWorkError) Unwrap() error { return e.err }

func processMetadataTagQueue(ctx context.Context, db *sql.DB, limit int, priorities []string, now time.Time, timeout time.Duration) (count int, err error) {
	if limit <= 0 {
		return 0, nil
	}
	limit = min(limit, 64)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	defer func() {
		if err != nil && ctx.Err() != nil {
			var workErr *metadataTagQueueWorkError
			if errors.As(err, &workErr) {
				workErr.err = ctx.Err()
			} else {
				err = ctx.Err()
			}
		}
	}()
	tx, release, err := storage.BeginBoundedTx(ctx, db)
	if err != nil {
		return 0, err
	}
	defer release()
	rows, err := tx.QueryContext(ctx, "SELECT work_id FROM work_metadata_tag_dirty WHERE retry_after<=? ORDER BY work_id LIMIT ?", now.Unix(), limit)
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
			return 0, &metadataTagQueueWorkError{workID: id, err: err}
		}
	}
	if err := tx.Commit(); err != nil {
		if ctx.Err() != nil && len(ids) > 0 {
			return 0, &metadataTagQueueWorkError{workID: ids[len(ids)-1], err: ctx.Err()}
		}
		return 0, err
	}
	return len(ids), nil
}
