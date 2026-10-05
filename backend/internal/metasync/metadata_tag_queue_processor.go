package metasync

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
)

// MetadataTagQueueProcessor drains eligible work in bounded transactions. One
// runner owns the adaptive batch size; retry state belongs to the database.
type MetadataTagQueueProcessor struct {
	db                   *sql.DB
	batchSize, successes int
	timeout              time.Duration
	now                  func() time.Time
}

func NewMetadataTagQueueProcessor(db *sql.DB) *MetadataTagQueueProcessor {
	return &MetadataTagQueueProcessor{db: db, batchSize: 32, timeout: 5 * time.Second, now: time.Now}
}

// ProcessBatch returns continueNow when another batch should run immediately.
// A work failure rolls back its whole batch, then durably defers only that work;
// the next batch can commit the other works. Errors are for protected logging.
func (p *MetadataTagQueueProcessor) ProcessBatch(ctx context.Context, priorities []string) (continueNow bool, err error) {
	count, err := processMetadataTagQueue(ctx, p.db, p.batchSize, priorities, p.now(), p.timeout)
	if err == nil {
		if count > 0 {
			p.successes++
			if p.successes >= 4 {
				p.batchSize = min(32, p.batchSize*2)
				p.successes = 0
			}
		}
		return count > 0, nil
	}
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	var failed *metadataTagQueueWorkError
	if !errors.As(err, &failed) {
		// Waiting for the write lock says nothing about projection cost.
		return false, err
	}
	p.successes = 0
	if errors.Is(err, context.DeadlineExceeded) && p.batchSize > 1 {
		p.batchSize = max(1, p.batchSize/2)
		return true, nil
	}
	if deferErr := p.deferWork(ctx, failed.workID); deferErr != nil {
		return false, errors.Join(err, deferErr)
	}
	return true, err
}

func (p *MetadataTagQueueProcessor) deferWork(ctx context.Context, workID int64) error {
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	tx, release, err := storage.BeginBoundedTx(ctx, p.db)
	if err != nil {
		return err
	}
	defer release()
	// Retrying after 30, 60, 120, 240, then 300 seconds survives restart.
	// A concurrent repair or work deletion can have acknowledged the row already.
	_, err = tx.ExecContext(ctx, `UPDATE work_metadata_tag_dirty
 SET retry_after=?+MIN(300,30*(1 << MIN(retry_count,4))), retry_count=retry_count+1 WHERE work_id=?`, p.now().Unix(), workID)
	if err != nil {
		return err
	}
	return tx.Commit()
}
