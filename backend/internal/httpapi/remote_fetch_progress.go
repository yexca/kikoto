package httpapi

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/yexca/kikoto/backend/internal/download"
)

const (
	remoteFetchProgressInterval = 250 * time.Millisecond
	remoteFetchProgressMaxDelay = time.Second
	remoteFetchProgressBytes    = 1 << 20
)

func remoteFetchTransferTotals(items []remoteWorkSavePlanItem) (int64, int) {
	var total int64
	unknown := 0
	for _, item := range items {
		if item.Action != "cache_download" {
			continue
		}
		if item.SizeBytes == nil {
			unknown++
			continue
		}
		total += *item.SizeBytes
	}
	return total, unknown
}

func validateRemoteFetchDownloadPlan(items []remoteWorkSavePlanItem, maxBytes int64) error {
	for _, item := range items {
		if item.Action != "cache_download" || item.SizeBytes == nil {
			continue
		}
		if *item.SizeBytes > maxBytes {
			return download.LimitError{LimitBytes: maxBytes, DeclaredBytes: *item.SizeBytes}
		}
	}
	return nil
}

type remoteFetchByteProgress struct {
	server          *Server
	ctx             context.Context
	jobID           int64
	nodeRunID       int64
	fileTotal       int
	current         int64
	total           int64
	unknownItems    int
	itemBase        int64
	itemUnknown     bool
	lastPersisted   int64
	lastPersistedAt time.Time
}

func newRemoteFetchByteProgress(ctx context.Context, server *Server, jobID int64, nodeRunID int64, items []remoteWorkSavePlanItem) (*remoteFetchByteProgress, error) {
	total, unknown := remoteFetchTransferTotals(items)
	progress := &remoteFetchByteProgress{
		server:       server,
		ctx:          ctx,
		jobID:        jobID,
		nodeRunID:    nodeRunID,
		fileTotal:    len(items),
		total:        total,
		unknownItems: unknown,
	}
	if err := progress.persist(0, remoteWorkSavePlanItem{}, 0); err != nil {
		return nil, err
	}
	return progress, nil
}

func (p *remoteFetchByteProgress) begin(fileIndex int, item remoteWorkSavePlanItem) error {
	p.itemBase = p.current
	p.itemUnknown = item.SizeBytes == nil
	return p.persist(fileIndex, item, 0)
}

func (p *remoteFetchByteProgress) includeDownload(item remoteWorkSavePlanItem) error {
	if item.SizeBytes == nil {
		p.unknownItems++
		return nil
	}
	if *item.SizeBytes < 0 || p.total > math.MaxInt64-*item.SizeBytes {
		return fmt.Errorf("invalid remote Fetch byte progress")
	}
	p.total += *item.SizeBytes
	return nil
}

func (p *remoteFetchByteProgress) report(fileIndex int, item remoteWorkSavePlanItem, written int64) {
	p.current = p.itemBase + written
	now := time.Now()
	elapsed := now.Sub(p.lastPersistedAt)
	if p.current < p.lastPersisted || elapsed >= remoteFetchProgressMaxDelay || (elapsed >= remoteFetchProgressInterval && p.current-p.lastPersisted >= remoteFetchProgressBytes) {
		_ = p.persist(fileIndex, item, written)
	}
}

func (p *remoteFetchByteProgress) complete(fileIndex int, item remoteWorkSavePlanItem, written int64) error {
	p.current = p.itemBase + written
	if p.itemUnknown {
		p.total += written
		if p.unknownItems > 0 {
			p.unknownItems--
		}
	}
	p.itemBase = p.current
	p.itemUnknown = false
	return p.persist(fileIndex, item, written)
}

func (p *remoteFetchByteProgress) abort(fileIndex int, item remoteWorkSavePlanItem) {
	p.current = p.itemBase
	p.itemUnknown = false
	_ = p.persist(fileIndex, item, 0)
}

func (p *remoteFetchByteProgress) persist(fileIndex int, item remoteWorkSavePlanItem, itemWritten int64) error {
	if p.current < 0 || p.total < 0 || p.unknownItems < 0 {
		return fmt.Errorf("invalid remote Fetch byte progress")
	}
	output := map[string]any{
		"current":             fileIndex,
		"total":               p.fileTotal,
		"bytes_current":       p.current,
		"bytes_total":         p.total,
		"bytes_unknown_items": p.unknownItems,
	}
	if item.ItemKey != "" {
		output["item_key"] = item.ItemKey
		output["action"] = item.Action
		output["cache_path"] = item.CachePath
		output["target_path"] = item.TargetPath
		output["item_bytes_current"] = itemWritten
		if item.SizeBytes != nil {
			output["item_bytes_total"] = *item.SizeBytes
		}
	}

	tx, err := p.server.db.BeginTx(p.ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(p.ctx, `
		UPDATE workflow_job
		SET progress_bytes_current = ?, progress_bytes_total = ?, progress_bytes_unknown_items = ?,
			heartbeat_at = CASE WHEN status = 'running' THEN CURRENT_TIMESTAMP ELSE heartbeat_at END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, p.current, p.total, p.unknownItems, p.jobID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(p.ctx, `
		UPDATE workflow_node_run
		SET status = 'running', output_json = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
		WHERE id = ?
	`, mustJSON(output), p.nodeRunID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	p.lastPersisted = p.current
	p.lastPersistedAt = time.Now()
	return nil
}
