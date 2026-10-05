package metasync

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func queueTestWorks(t *testing.T, count int) (*sql.DB, []int64) {
	t.Helper()
	db := openTestDB(t)
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	ids := []int64{}
	for i := 0; i < count; i++ {
		var code string
		if count <= 100 {
			code = testfixture.WorkCode(testfixture.PrefixRJ, i)
		} else {
			code = testfixture.WorkCodeAt(i)
		}
		result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Example Work')", code)
		if err != nil {
			t.Fatal(err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		if _, err := db.Exec("INSERT INTO work_metadata_tag_dirty(work_id) VALUES (?)", id); err != nil {
			t.Fatal(err)
		}
	}
	return db, ids
}

func TestSnapshotTriggersOnlyQueueExistingWorksAndAllowOrphans(t *testing.T) {
	db, ids := queueTestWorks(t, 2)
	ctx := context.Background()
	for i, id := range ids {
		if _, err := db.Exec("INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,?,'{}' FROM metadata_provider WHERE code='dlsite'", id, testfixture.WorkCode(testfixture.PrefixRJ, i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ProcessMetadataTagQueue(ctx, db, 64, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM work WHERE id=?", ids[0]); err != nil {
		t.Fatalf("delete with retained snapshot: %v", err)
	}
	var workID sql.NullInt64
	if err := db.QueryRow("SELECT work_id FROM metadata_snapshot WHERE external_id='RJ00000000'").Scan(&workID); err != nil || workID.Valid {
		t.Fatalf("orphan not retained: %v %v", workID, err)
	}
	for _, statement := range []string{
		"UPDATE metadata_snapshot SET snapshot_json='{}' WHERE work_id IS NULL",
		"DELETE FROM metadata_snapshot WHERE work_id IS NULL",
		"INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT NULL,id,'RJ00000000','{}' FROM metadata_provider WHERE code='dlsite'",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	var queued int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty").Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("orphan affected queue: %d %v", queued, err)
	}
	// Detaching a still-live work and deleting its retained snapshot queue that
	// work, without synthesizing an id from NULL or affecting another work.
	if _, err := db.Exec("UPDATE metadata_snapshot SET work_id=NULL WHERE work_id=?", ids[1]); err != nil {
		t.Fatal(err)
	}
	var queuedID int64
	if err := db.QueryRow("SELECT work_id FROM work_metadata_tag_dirty").Scan(&queuedID); err != nil || queuedID != ids[1] {
		t.Fatalf("detached live work: %d %v", queuedID, err)
	}
	if _, err := db.Exec("DELETE FROM metadata_snapshot"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty").Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("cascade queue: %d %v", queued, err)
	}
}

func TestQueueProcessorDefersFailedWorkWithoutBlockingLaterWorksAndRetriesAfterRestart(t *testing.T) {
	db, ids := queueTestWorks(t, 3)
	if _, err := db.Exec(fmt.Sprintf("CREATE TRIGGER example_projection_failure BEFORE INSERT ON work_metadata_tag_projection WHEN new.work_id=%d BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END", ids[0])); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Now()
	p := NewMetadataTagQueueProcessor(db)
	p.now = func() time.Time { return now }
	more, err := p.ProcessBatch(ctx, nil)
	var failed *metadataTagQueueWorkError
	if !more || !errors.As(err, &failed) || failed.workID != ids[0] {
		t.Fatalf("failure not isolated: %v %v", more, err)
	}
	var retries, after int64
	if err := db.QueryRow("SELECT retry_count,retry_after FROM work_metadata_tag_dirty WHERE work_id=?", ids[0]).Scan(&retries, &after); err != nil || retries != 1 || after != now.Unix()+30 {
		t.Fatalf("durable retry: %d %d %v", retries, after, err)
	}
	// A restart retains the backoff. Other works commit before this retry is due.
	p = NewMetadataTagQueueProcessor(db)
	p.now = func() time.Time { return now }
	if more, err := p.ProcessBatch(ctx, nil); !more || err != nil {
		t.Fatalf("later works blocked: %v %v", more, err)
	}
	var projected int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_projection").Scan(&projected); err != nil || projected != 2 {
		t.Fatalf("later projections: %d %v", projected, err)
	}
	if more, err := p.ProcessBatch(ctx, nil); more || err != nil {
		t.Fatalf("retry before backoff: %v %v", more, err)
	}
	now = now.Add(30 * time.Second)
	if more, err := p.ProcessBatch(ctx, nil); !more || err == nil {
		t.Fatalf("due retry skipped: %v %v", more, err)
	}
	if err := db.QueryRow("SELECT retry_count,retry_after FROM work_metadata_tag_dirty WHERE work_id=?", ids[0]).Scan(&retries, &after); err != nil || retries != 2 || after != now.Unix()+60 {
		t.Fatalf("exponential retry: %d %d %v", retries, after, err)
	}
	previousDelay := int64(60)
	for i, delay := range []int64{120, 240, 300, 300} {
		now = now.Add(time.Duration(previousDelay) * time.Second)
		if more, err := p.ProcessBatch(ctx, nil); !more || err == nil {
			t.Fatalf("repeated failure skipped: %v %v", more, err)
		}
		if err := db.QueryRow("SELECT retry_count,retry_after FROM work_metadata_tag_dirty WHERE work_id=?", ids[0]).Scan(&retries, &after); err != nil || retries != int64(i+3) || after != now.Unix()+delay {
			t.Fatalf("bounded backoff: %d %d %v", retries, after, err)
		}
		previousDelay = delay
	}
	if _, err := db.Exec("DROP TRIGGER example_projection_failure"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Duration(previousDelay) * time.Second)
	if more, err := p.ProcessBatch(ctx, nil); !more || err != nil {
		t.Fatalf("fixed work retry: %v %v", more, err)
	}
	var pending int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty").Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("retry not acknowledged: %d %v", pending, err)
	}
}

func TestQueueProcessorCancellationDoesNotDeferOrAcknowledgeWorks(t *testing.T) {
	db, _ := queueTestWorks(t, 2)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p := NewMetadataTagQueueProcessor(db)
	if more, err := p.ProcessBatch(ctx, nil); more || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled processor: %v %v", more, err)
	}
	var pending int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty WHERE retry_after=0 AND retry_count=0").Scan(&pending); err != nil || pending != 2 {
		t.Fatalf("cancellation changed pending works: %d %v", pending, err)
	}
}

func TestQueueProcessorLockWaitDoesNotShrinkBatchAndReducedBatchRecovers(t *testing.T) {
	db, _ := queueTestWorks(t, 128)
	db.SetMaxOpenConns(2)
	ctx := context.Background()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	p := NewMetadataTagQueueProcessor(db)
	p.timeout = 80 * time.Millisecond
	if more, err := p.ProcessBatch(ctx, nil); more || !errors.Is(err, context.DeadlineExceeded) || p.batchSize != 32 {
		t.Fatalf("lock wait changed batch: %v %v size=%d", more, err, p.batchSize)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	p.timeout = 5 * time.Second
	p.batchSize = 1 // Resume from a previously reduced projection batch.
	for {
		more, err := p.ProcessBatch(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !more {
			break
		}
	}
	if p.batchSize != 32 {
		t.Fatalf("batch never recovered: %d", p.batchSize)
	}
	var retries int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty").Scan(&retries); err != nil || retries != 0 {
		t.Fatalf("backlog not drained: %d %v", retries, err)
	}
}
