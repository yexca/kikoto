package storage

import (
	"database/sql"
	"testing"
	"time"
)

func TestPoolMonitorReportsStuckSaturationOnceAndRecovery(t *testing.T) {
	sample := func(inUse int, waitCount int64) sql.DBStats {
		return sql.DBStats{MaxOpenConnections: 4, InUse: inUse, WaitCount: waitCount}
	}
	monitor := poolMonitor{}
	// A full pool whose new waiters never finish is reported once it persists.
	steps := []struct {
		stats sql.DBStats
		want  poolCondition
	}{
		{stats: sample(4, 2), want: poolSteady},
		{stats: sample(4, 5), want: poolSteady},
		{stats: sample(4, 5), want: poolSaturated},
		{stats: sample(4, 9), want: poolSteady},
		{stats: sample(1, 9), want: poolRecovered},
		{stats: sample(1, 9), want: poolSteady},
	}
	for index, step := range steps {
		if got := monitor.observe(step.stats).condition; got != step.want {
			t.Fatalf("sample %d condition = %v, want %v", index, got, step.want)
		}
	}
}

func TestPoolMonitorIgnoresBusyPoolWithoutWaiters(t *testing.T) {
	monitor := poolMonitor{}
	for index := range 5 {
		stats := sql.DBStats{MaxOpenConnections: 4, InUse: 4}
		if got := monitor.observe(stats).condition; got != poolSteady {
			t.Fatalf("sample %d condition = %v, want steady", index, got)
		}
	}
}

func TestPoolMonitorReportsSlowCompletedWaits(t *testing.T) {
	monitor := poolMonitor{}
	fast := sql.DBStats{MaxOpenConnections: 4, InUse: 2, WaitCount: 2, WaitDuration: 100 * time.Millisecond}
	if got := monitor.observe(fast).condition; got != poolSteady {
		t.Fatalf("fast waits condition = %v, want steady", got)
	}
	slow := sql.DBStats{MaxOpenConnections: 4, InUse: 2, WaitCount: 4, WaitDuration: 100*time.Millisecond + 3*time.Second}
	if got := monitor.observe(slow).condition; got != poolContended {
		t.Fatalf("slow waits condition = %v, want contended", got)
	}
}
