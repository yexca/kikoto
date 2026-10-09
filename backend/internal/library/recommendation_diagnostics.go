package library

import "sync/atomic"

// Counters measure returned evidence/features, logical matched membership, and
// committed writes, rather than SQLite's internal B-tree visits or peak memory.
type recommendationDiagnostics struct {
	stateRows      atomic.Int64
	featureRows    atomic.Int64
	nameRows       atomic.Int64
	frequencyRows  atomic.Int64
	writtenRows    atomic.Int64
	writerWait     atomic.Int64
	scoredWorks    atomic.Int64
	recallRows     atomic.Int64
	membershipRows atomic.Int64
	contextRows    atomic.Int64
}

func (s *Store) RecommendationDiagnostics() map[string]int64 {
	d := &s.recommendationDiagnostics
	return map[string]int64{
		"rows_state": d.stateRows.Load(), "rows_feature": d.featureRows.Load(),
		"rows_names": d.nameRows.Load(), "rows_frequency": d.frequencyRows.Load(),
		"written_rows": d.writtenRows.Load(), "writer_gate_wait_ns": d.writerWait.Load(),
		"scored_works": d.scoredWorks.Load(),
		"rows_recall":  d.recallRows.Load(), "rows_membership": d.membershipRows.Load(), "rows_context": d.contextRows.Load(),
	}
}
