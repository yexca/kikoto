package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

type rankingPullCallback func(context.Context, rankingList, rankingVariant) (rankingPull, error)

func (callback rankingPullCallback) pull(ctx context.Context, list rankingList, variant rankingVariant) (rankingPull, error) {
	return callback(ctx, list, variant)
}

func TestRankingRefreshDuringPullSurvivesItsResult(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(strconv.FormatBool(failed), func(t *testing.T) {
			env := newSubscriptionTestEnv(t)
			ctx := context.Background()
			if err := env.server.ensureRankingDispatchers(ctx); err != nil {
				t.Fatal(err)
			}
			list := env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,pull_requested_at)
				VALUES('dlsite','day',0,'2000-01-01 00:00:00')`)
			requested := false
			puller := rankingPullCallback(func(context.Context, rankingList, rankingVariant) (rankingPull, error) {
				if !requested {
					requested = true
					if _, err := env.server.requestRankingPulls(ctx, []int64{list.ID}, env.adminID, "manual_run"); err != nil {
						t.Fatal(err)
					}
				}
				if failed {
					return rankingPull{}, errors.New("example ranking failure")
				}
				return rankingItems("RJ00000000"), nil
			})
			env.runRankingPull(t, puller, time.Now().UTC())
			if !env.rankingList(t, list.ID).PullRequested {
				t.Fatal("the completed pull erased the refresh requested while it was running")
			}
			if next := env.scalar(t, `SELECT trigger.next_run_at FROM workflow_trigger AS trigger
				JOIN workflow_definition AS definition ON definition.id=trigger.workflow_definition_id
				WHERE definition.code=?`, dlsiteRankingWorkflowCode); !next.Valid || next.String > formatWorkflowTimestamp(time.Now().UTC()) {
				t.Fatalf("the retained refresh is not due: %v", next)
			}
		})
	}
}

func TestRankingPullCompletionReadsCurrentSchedule(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,pull_requested_at)
		VALUES('dlsite','day',1,'2000-01-01 00:00:00')`)
	changed := false
	puller := rankingPullCallback(func(context.Context, rankingList, rankingVariant) (rankingPull, error) {
		if !changed {
			changed = true
			if _, err := env.db.Exec("UPDATE ranking_list SET auto_refresh=0,next_pull_at=NULL WHERE id=?", list.ID); err != nil {
				t.Fatal(err)
			}
		}
		return rankingItems("RJ00000000"), nil
	})
	env.runRankingPull(t, puller, time.Now().UTC())
	if current := env.rankingList(t, list.ID); current.NextPullAt != nil || current.AutoRefresh {
		t.Fatalf("completion scheduled another pull after automatic pulls were disabled: %+v", current)
	}
}

func TestRankingFirstPullCancellationRetainsOnlyAutomaticSchedule(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		t.Run(strconv.FormatBool(automatic), func(t *testing.T) {
			env := newSubscriptionTestEnv(t)
			ctx := context.Background()
			if err := env.server.ensureRankingDispatchers(ctx); err != nil {
				t.Fatal(err)
			}
			list := env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,refresh_interval_minutes,pull_requested_at)
				VALUES('dlsite','day',?,60,'2000-01-01 00:00:00')`, automatic)
			runs, err := env.server.requestRankingPulls(ctx, []int64{list.ID}, env.adminID, "ranking_added")
			if err != nil || len(runs) != 1 {
				t.Fatalf("queue: %+v %v", runs, err)
			}
			id := strconv.FormatInt(runs[0].RunID, 10)
			response := env.request(t, env.adminID, http.MethodPost, "/api/workflow-runs/"+id+"/cancel", nil,
				env.server.cancelWorkflowRun, "id", id)
			if response.Code != http.StatusOK {
				t.Fatalf("cancel = %d %s", response.Code, response.Body.String())
			}
			current := env.rankingList(t, list.ID)
			if current.PullRequested {
				t.Error("the cancelled first request remains pending")
			}
			next := env.scalar(t, `SELECT trigger.next_run_at FROM workflow_trigger AS trigger
				JOIN workflow_definition AS definition ON definition.id=trigger.workflow_definition_id
				WHERE definition.code=?`, dlsiteRankingWorkflowCode)
			if automatic {
				if current.NextPullAt == nil || !next.Valid || next.String <= formatWorkflowTimestamp(time.Now().UTC()) {
					t.Fatalf("the automatic list has no future dispatch after cancellation: list=%+v dispatcher=%v", current, next)
				}
			} else if current.NextPullAt != nil || next.Valid {
				t.Fatalf("cancelling a manual pull scheduled another one: list=%+v dispatcher=%v", current, next)
			}
		})
	}
}

func TestRankingStartupSettlesAnInterruptedFirstPullSchedule(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	ctx := context.Background()
	list := env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,refresh_interval_minutes,pull_requested_at)
		VALUES('dlsite','day',1,60,'2000-01-01 00:00:00')`)
	if _, err := env.server.requestRankingPulls(ctx, []int64{list.ID}, env.adminID, "ranking_added"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := env.server.claimNextQueuedWorkflowJob(ctx, "interrupted-ranking-runner"); err != nil || !ok {
		t.Fatalf("claim = %v %v", ok, err)
	}
	if _, err := env.server.settleInterruptedWorkflowRuns(ctx, "example restart"); err != nil {
		t.Fatal(err)
	}
	if err := env.server.ensureRankingDispatchers(ctx); err != nil {
		t.Fatal(err)
	}
	current := env.rankingList(t, list.ID)
	if current.PullRequested || current.NextPullAt == nil || *current.NextPullAt <= formatWorkflowTimestamp(time.Now().UTC()) {
		t.Fatalf("the interrupted first pull was not settled to a future automatic pull: %+v", current)
	}
}

func TestRankingClaimRecoveryKeepsTheNextRefresh(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	ctx := context.Background()
	list := env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,refresh_interval_minutes,pull_requested_at)
		VALUES('dlsite','day',1,60,'2000-01-01 00:00:00')`)
	if err := env.server.ensureRankingDispatchers(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := env.server.requestRankingPulls(ctx, []int64{list.ID}, env.adminID, "ranking_added"); err != nil {
		t.Fatal(err)
	}
	job, ok, err := env.server.claimNextQueuedWorkflowJob(ctx, "interrupted-ranking-runner")
	if err != nil || !ok {
		t.Fatalf("claim = %v %v", ok, err)
	}
	stopping, stop := context.WithCancel(ctx)
	defer stop()
	puller := rankingPullCallback(func(context.Context, rankingList, rankingVariant) (rankingPull, error) {
		if env.rankingList(t, list.ID).PullRequested {
			t.Fatal("the first request was not consumed before contacting the provider")
		}
		if _, err := env.server.requestRankingPulls(ctx, []int64{list.ID}, env.adminID, "manual_run"); err != nil {
			t.Fatal(err)
		}
		stop()
		return rankingPull{}, stopping.Err()
	})
	if err := env.server.executeRankingPullJobWith(stopping, job, puller, time.Now); !errors.Is(err, context.Canceled) {
		t.Fatalf("interrupted pull = %v", err)
	}
	// A new process reads only committed database state, including the claim
	// made before the request that did not finish.
	env.server = NewServer(env.db, config.Config{})
	if _, err := env.server.settleInterruptedWorkflowRuns(ctx, "example restart"); err != nil {
		t.Fatal(err)
	}
	if err := env.server.ensureRankingDispatchers(ctx); err != nil {
		t.Fatal(err)
	}
	if current := env.rankingList(t, list.ID); !current.PullRequested || current.NextPullAt == nil {
		t.Fatalf("recovery lost the separate next request or its automatic schedule: %+v", current)
	}
}

func TestRankingLateProgressPreservesCancellationSettlement(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	ctx := context.Background()
	list := env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,refresh_interval_minutes,pull_requested_at)
		VALUES('dlsite','day',1,60,'2000-01-01 00:00:00')`)
	if err := env.server.ensureRankingDispatchers(ctx); err != nil {
		t.Fatal(err)
	}
	queued, err := env.server.enqueueRankingPull(ctx, rankingPullTarget{Provider: rankingProviderDLsite}, workflowRunTrigger{Type: "manual"}, env.adminID)
	if err != nil {
		t.Fatal(err)
	}
	job, ok, err := env.server.claimNextQueuedWorkflowJob(ctx, "cancelled-ranking-runner")
	if err != nil || !ok {
		t.Fatalf("claim = %v %v", ok, err)
	}
	stopping, stop := context.WithCancel(ctx)
	defer stop()
	var cancelledNext string
	puller := rankingPullCallback(func(context.Context, rankingList, rankingVariant) (rankingPull, error) {
		id := strconv.FormatInt(queued.RunID, 10)
		response := env.request(t, env.adminID, http.MethodPost, "/api/workflow-runs/"+id+"/cancel", nil,
			env.server.cancelWorkflowRun, "id", id)
		if response.Code != http.StatusOK {
			t.Fatalf("cancel = %d %s", response.Code, response.Body.String())
		}
		current := env.rankingList(t, list.ID)
		if current.NextPullAt == nil || current.PullRequested {
			t.Fatalf("cancelled run has no future schedule or kept its old request: %+v", current)
		}
		cancelledNext = *current.NextPullAt
		// An upstream response can race cancellation before the executor sees
		// its cancelled context. Its progress write must not reopen settlement.
		if err := env.server.updateRankingPullCheckpoint(ctx, job, []int64{list.ID}, 1, len(list.Variants)); err != nil {
			t.Fatal(err)
		}
		stop()
		return rankingPull{}, stopping.Err()
	})
	if err := env.server.executeRankingPullJobWith(stopping, job, puller, time.Now); !errors.Is(err, context.Canceled) {
		t.Fatalf("interrupted pull = %v", err)
	}
	if err := env.server.reconcileInterruptedRankingSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	if settled := env.scalar(t, "SELECT json_extract(checkpoint_json, '$.rankingScheduleSettled') FROM workflow_job WHERE id=?", job.ID); settled.String != "1" {
		t.Fatalf("cancellation settlement was overwritten by progress: %v", settled)
	}
	if current := env.rankingList(t, list.ID); current.NextPullAt == nil || *current.NextPullAt != cancelledNext {
		t.Fatalf("recovery moved an already settled cancellation schedule: %+v", current)
	}
}

func TestRankingPartialScheduleWriteFailureIsReconciled(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	ctx := context.Background()
	day := env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,refresh_interval_minutes,last_pulled_at,pull_requested_at)
		VALUES('dlsite','day',1,60,'2000-01-01 00:00:00','2000-01-01 00:00:00')`)
	env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,refresh_interval_minutes,pull_requested_at)
		VALUES('dlsite','week',1,360,'2000-01-01 00:00:00')`)
	if err := env.server.ensureRankingDispatchers(ctx); err != nil {
		t.Fatal(err)
	}
	queued, err := env.server.enqueueRankingPull(ctx, rankingPullTarget{Provider: rankingProviderDLsite}, workflowRunTrigger{Type: "manual"}, env.adminID)
	if err != nil {
		t.Fatal(err)
	}
	job, ok, err := env.server.claimNextQueuedWorkflowJob(ctx, "partial-ranking-runner")
	if err != nil || !ok {
		t.Fatalf("claim = %v %v", ok, err)
	}
	env.exec(t, `CREATE TRIGGER example_ranking_schedule_failure BEFORE UPDATE OF last_pulled_at ON ranking_list
		WHEN NEW.id=`+strconv.FormatInt(day.ID, 10)+` AND NEW.last_status='succeeded'
		BEGIN SELECT RAISE(FAIL, 'example schedule failure'); END`)
	changed := false
	puller := rankingPullCallback(func(context.Context, rankingList, rankingVariant) (rankingPull, error) {
		if !changed {
			changed = true
			current := env.rankingList(t, day.ID)
			next := current
			next.RefreshIntervalMinutes = 120
			if err := env.server.saveRankingList(ctx, current, next, time.Now()); err != nil {
				t.Fatal(err)
			}
		}
		return rankingItems("RJ00000000"), nil
	})
	if err := env.server.executeRankingPullJobWith(ctx, job, puller, time.Now); err != nil {
		t.Fatal(err)
	}
	if status := env.scalar(t, "SELECT status FROM workflow_run WHERE id=?", queued.RunID); status.String != "partial" {
		t.Fatalf("run with one schedule write failure = %v", status)
	}
	env.exec(t, "DROP TRIGGER example_ranking_schedule_failure")
	if err := env.server.handleWorkflowJobResult(ctx, ctx, job, nil); err != nil {
		t.Fatal(err)
	}
	current := env.rankingList(t, day.ID)
	if current.NextPullAt == nil || *current.NextPullAt <= formatWorkflowTimestamp(time.Now().UTC()) {
		t.Fatalf("partial completion left the changed schedule overdue: %+v", current)
	}
	// A reconciler that selected the job before settlement can reach it
	// afterwards. The persisted marker makes that settlement idempotent.
	tx, err := env.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := env.server.settleInterruptedRankingPullTx(ctx, tx, queued.RunID, time.Now().Add(24*time.Hour)); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if after := env.rankingList(t, day.ID); after.NextPullAt == nil || *after.NextPullAt != *current.NextPullAt {
		t.Fatalf("an already settled schedule moved during a repeated settlement: before=%+v after=%+v", current, after)
	}
}

func TestRankingSnapshotFailureKeepsItsRecordedRetry(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.insertRankingList(t, `INSERT INTO ranking_list(provider,period,auto_refresh,refresh_interval_minutes,pull_requested_at)
		VALUES('dlsite','day',1,120,'2000-01-01 00:00:00')`)
	env.exec(t, `CREATE TRIGGER example_ranking_snapshot_failure BEFORE INSERT ON ranking_snapshot
		BEGIN SELECT RAISE(FAIL, 'example snapshot failure'); END`)
	now := time.Now().UTC().Truncate(time.Second)
	env.runRankingPull(t, &fakeRankingPuller{pulls: map[int64]rankingPull{list.ID: rankingItems("RJ00000000")}}, now)
	if err := env.server.reconcileInterruptedRankingSchedules(context.Background()); err != nil {
		t.Fatal(err)
	}
	if current := env.rankingList(t, list.ID); current.NextPullAt == nil || *current.NextPullAt != formatWorkflowTimestamp(now.Add(time.Hour)) {
		t.Fatalf("a snapshot failure's persisted retry was replaced by the ordinary two-hour interval: %+v", current)
	}
}
