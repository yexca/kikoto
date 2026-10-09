package library

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

type RecommendationSessionSnapshot struct {
	GenerationID      int64
	CatalogEpoch      int64
	UserID            int64
	Config            RecommendationConfig
	contextSigningKey string
}

const recommendationSessionRetentionSQL = "datetime('now', '-90 days')"

var ErrRecommendationBusy = errors.New("recommendation preparation queue is full")

type recommendationPreparation struct {
	done     chan struct{}
	cancel   context.CancelFunc
	waiters  int
	snapshot RecommendationSessionSnapshot
	err      error
}

func (s *Store) snapshotForRecommendation(ctx context.Context, userID int64, sessionID string) (RecommendationSessionSnapshot, error) {
	if userID <= 0 {
		return RecommendationSessionSnapshot{Config: s.LoadRecommendationConfig(ctx)}, nil
	}
	if strings.TrimSpace(sessionID) == "" {
		epoch, err := s.publishedRecommendationEpoch(ctx)
		if err != nil {
			return RecommendationSessionSnapshot{}, err
		}
		revision, err := recommendationUserRevision(ctx, s.db, userID)
		if err != nil {
			return RecommendationSessionSnapshot{}, err
		}
		raw, _ := json.Marshal(s.LoadUserRecommendationConfig(ctx, userID))
		sum := sha256.Sum256(append([]byte(fmt.Sprintf("%d:%d:", epoch, revision)), raw...))
		sessionID = "legacy:" + hex.EncodeToString(sum[:])[:48]
	}
	return s.PrepareRecommendationSession(ctx, userID, sessionID)
}

// Preparation is coalesced by effective inputs. CPU work and paged reads do not
// hold a write transaction or a connection while waiting for either gate.
func (s *Store) PrepareRecommendationSession(ctx context.Context, userID int64, sessionID string) (RecommendationSessionSnapshot, error) {
	sessionID = strings.TrimSpace(sessionID)
	if userID <= 0 {
		return RecommendationSessionSnapshot{Config: s.LoadRecommendationConfig(ctx)}, nil
	}
	if sessionID == "" {
		return s.snapshotForRecommendation(ctx, userID, "")
	}
	if len(sessionID) > 64 {
		return RecommendationSessionSnapshot{}, errors.New("recommendation session id is too long")
	}
	if snapshot, found, err := boundRecommendationSession(ctx, s.db, userID, sessionID); err != nil {
		return snapshot, err
	} else if found {
		return s.ensureRecommendationContextKey(ctx, snapshot)
	}
	select {
	case s.recommendationQueue <- struct{}{}:
		defer func() { <-s.recommendationQueue }()
	default:
		return RecommendationSessionSnapshot{}, ErrRecommendationBusy
	}
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return RecommendationSessionSnapshot{}, err
		}
		epoch, err := s.publishedRecommendationEpoch(ctx)
		if err != nil {
			return RecommendationSessionSnapshot{}, err
		}
		revision, err := recommendationUserRevision(ctx, s.db, userID)
		if err != nil {
			return RecommendationSessionSnapshot{}, err
		}
		config := s.LoadUserRecommendationConfig(ctx, userID)
		raw, _ := json.Marshal(config)
		key := fmt.Sprintf("%d:%d:%d:%s:%s", userID, epoch, revision, RecommendationAlgorithmVersion, raw)
		snapshot, err := s.joinRecommendationPreparation(ctx, key, userID, epoch, revision, config, string(raw))
		if errors.Is(err, errRecommendationInputsChanged) {
			continue
		}
		if err != nil {
			return snapshot, err
		}
		snapshot, err = s.publishRecommendationBinding(ctx, userID, sessionID, snapshot)
		if errors.Is(err, errRecommendationInputsChanged) {
			continue
		}
		if err != nil {
			return snapshot, err
		}
		return s.ensureRecommendationContextKey(ctx, snapshot)
	}
	return RecommendationSessionSnapshot{}, ErrRecommendationBusy
}

var errRecommendationInputsChanged = errors.New("recommendation inputs changed during preparation")

func (s *Store) joinRecommendationPreparation(ctx context.Context, key string, userID, epoch, revision int64, config RecommendationConfig, configJSON string) (RecommendationSessionSnapshot, error) {
	s.recommendationMu.Lock()
	call := s.recommendationFlights[key]
	if call == nil {
		taskCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		call = &recommendationPreparation{done: make(chan struct{}), cancel: cancel}
		s.recommendationFlights[key] = call
		go func() {
			call.snapshot, call.err = s.prepareRecommendationGeneration(taskCtx, userID, epoch, revision, config, configJSON)
			s.recommendationMu.Lock()
			if s.recommendationFlights[key] == call {
				delete(s.recommendationFlights, key)
			}
			close(call.done)
			s.recommendationMu.Unlock()
			cancel()
		}()
	}
	call.waiters++
	s.recommendationMu.Unlock()
	defer func() {
		s.recommendationMu.Lock()
		call.waiters--
		if call.waiters == 0 {
			if s.recommendationFlights[key] == call {
				delete(s.recommendationFlights, key)
			}
			call.cancel()
		}
		s.recommendationMu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return RecommendationSessionSnapshot{}, ctx.Err()
	case <-call.done:
		return call.snapshot, call.err
	}
}

func (s *Store) prepareRecommendationGeneration(ctx context.Context, userID, epoch, revision int64, config RecommendationConfig, configJSON string) (RecommendationSessionSnapshot, error) {
	snapshot := RecommendationSessionSnapshot{UserID: userID, CatalogEpoch: epoch, Config: config}
	var reusable int64
	err := s.db.QueryRowContext(ctx, `SELECT g.id,COALESCE(json_extract(p.profile_json,'$.contextSigningKey'),'') FROM recommendation_generation AS g JOIN recommendation_generation_profile AS p ON p.generation_id=g.id WHERE g.user_id = ? AND g.algorithm_version = ? AND g.catalog_epoch = ? AND g.user_revision = ? AND g.ready = 1 AND g.config_json = ? ORDER BY g.id DESC LIMIT 1`, userID, RecommendationAlgorithmVersion, epoch, revision, configJSON).Scan(&reusable, &snapshot.contextSigningKey)
	if err == nil {
		snapshot.GenerationID = reusable
		return s.ensureRecommendationContextKey(ctx, snapshot)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return snapshot, err
	}
	// A staged generation pins its epoch before feature reads. It cannot be bound
	// until every state batch and the profile have committed and revision is checked.
	err = s.withRecommendationWrite(ctx, func(tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM recommendation_catalog_epoch WHERE id = ? AND published = 1)", epoch).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errRecommendationInputsChanged
		}
		result, err := tx.ExecContext(ctx, `INSERT INTO recommendation_generation(user_id,algorithm_version,config_json,input_revision,user_revision,catalog_epoch,ready) VALUES (?,?,?,?,?,?,0)`, userID, RecommendationAlgorithmVersion, configJSON, epoch, revision, epoch)
		if err != nil {
			return err
		}
		snapshot.GenerationID, err = result.LastInsertId()
		return err
	})
	if err != nil {
		return snapshot, err
	}
	select {
	case s.recommendationCPU <- struct{}{}:
		defer func() { <-s.recommendationCPU }()
	case <-ctx.Done():
		return snapshot, ctx.Err()
	}
	profile, err := s.prepareRecommendationProfile(ctx, userID, epoch)
	if err != nil {
		return snapshot, err
	}
	var contextKey [32]byte
	if _, err := rand.Read(contextKey[:]); err != nil {
		return snapshot, err
	}
	profile.ContextSigningKey = hex.EncodeToString(contextKey[:])
	snapshot.contextSigningKey = profile.ContextSigningKey
	profileJSON, err := json.Marshal(profile)
	if err != nil {
		return snapshot, err
	}
	ids := make([]int64, 0, len(profile.States))
	for id := range profile.States {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for start := 0; start < len(ids); start += 128 {
		batch := ids[start:min(start+128, len(ids))]
		if err := s.withRecommendationWrite(ctx, func(tx *sql.Tx) error {
			statement, err := tx.PrepareContext(ctx, "INSERT INTO recommendation_generation_state(generation_id,work_id,primary_code,listening_status,favorite) VALUES (?,?,?,?,?)")
			if err != nil {
				return err
			}
			defer func() { _ = statement.Close() }()
			for _, id := range batch {
				state := profile.States[id]
				if _, err := statement.ExecContext(ctx, snapshot.GenerationID, id, state.PrimaryCode, state.ListeningStatus, state.Favorite); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return snapshot, err
		}
	}
	err = s.withRecommendationWrite(ctx, func(tx *sql.Tx) error {
		current, err := recommendationUserRevision(ctx, tx, userID)
		if err != nil {
			return err
		}
		if current != revision || loadUserRecommendationConfig(ctx, tx, userID) != config {
			return errRecommendationInputsChanged
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO recommendation_generation_profile(generation_id,profile_json) VALUES (?,?)", snapshot.GenerationID, string(profileJSON)); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE recommendation_generation SET ready = 1 WHERE id = ?", snapshot.GenerationID)
		return err
	})
	return snapshot, err
}

func (s *Store) withRecommendationWrite(ctx context.Context, fn func(*sql.Tx) error) error {
	start := time.Now()
	select {
	case s.recommendationWrite <- struct{}{}:
		defer func() { <-s.recommendationWrite }()
	case <-ctx.Done():
		return ctx.Err()
	}
	s.recommendationDiagnostics.writerWait.Add(time.Since(start).Nanoseconds())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var before, after int64
	if err := tx.QueryRowContext(ctx, "SELECT total_changes()").Scan(&before); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, "SELECT total_changes()").Scan(&after); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.recommendationDiagnostics.writtenRows.Add(after - before)
	return nil
}

func (s *Store) publishRecommendationBinding(ctx context.Context, userID int64, sessionID string, snapshot RecommendationSessionSnapshot) (RecommendationSessionSnapshot, error) {
	err := s.withRecommendationWrite(ctx, func(tx *sql.Tx) error {
		// Concurrent first requests for one session must all use the winning binding.
		if bound, found, err := boundRecommendationSession(ctx, tx, userID, sessionID); err != nil {
			return err
		} else if found {
			snapshot = bound
			return nil
		}
		var valid bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM recommendation_generation WHERE id = ? AND user_id = ? AND ready = 1 AND algorithm_version = ?)", snapshot.GenerationID, userID, RecommendationAlgorithmVersion).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return errRecommendationInputsChanged
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO recommendation_client_session(user_id,session_id,generation_id) VALUES (?,?,?) ON CONFLICT(user_id,session_id) DO UPDATE SET generation_id = excluded.generation_id, created_at = CURRENT_TIMESTAMP`, userID, sessionID, snapshot.GenerationID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO recommendation_snapshot_state(user_id,current_generation_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET current_generation_id = excluded.current_generation_id, updated_at = CURRENT_TIMESTAMP`, userID, snapshot.GenerationID)
		return err
	})
	return snapshot, err
}

func boundRecommendationSession(ctx context.Context, queryer recommendationConfigQueryer, userID int64, sessionID string) (RecommendationSessionSnapshot, bool, error) {
	var snapshot RecommendationSessionSnapshot
	var raw string
	err := queryer.QueryRowContext(ctx, `SELECT g.id,g.catalog_epoch,g.config_json,COALESCE(json_extract(p.profile_json,'$.contextSigningKey'),'') FROM recommendation_client_session s JOIN recommendation_generation g ON g.id = s.generation_id JOIN recommendation_generation_profile p ON p.generation_id=g.id WHERE s.user_id = ? AND s.session_id = ? AND g.algorithm_version = ? AND g.ready = 1 AND s.created_at >= `+recommendationSessionRetentionSQL, userID, sessionID, RecommendationAlgorithmVersion).Scan(&snapshot.GenerationID, &snapshot.CatalogEpoch, &raw, &snapshot.contextSigningKey)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshot, false, nil
	}
	if err != nil {
		return snapshot, false, err
	}
	snapshot.UserID = userID
	snapshot.Config, err = decodeRecommendationConfig(raw)
	return snapshot, err == nil, err
}

// Key installation preserves a ready generation's frozen profile and session
// binding, including caches created without authenticated context identifiers.
func (s *Store) ensureRecommendationContextKey(ctx context.Context, snapshot RecommendationSessionSnapshot) (RecommendationSessionSnapshot, error) {
	if snapshot.GenerationID <= 0 || len(snapshot.contextSigningKey) == 64 {
		return snapshot, nil
	}
	var rawKey [32]byte
	if _, err := rand.Read(rawKey[:]); err != nil {
		return snapshot, err
	}
	proposed := hex.EncodeToString(rawKey[:])
	err := s.withRecommendationWrite(ctx, func(tx *sql.Tx) error {
		var key string
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(json_extract(profile_json,'$.contextSigningKey'),'') FROM recommendation_generation_profile WHERE generation_id=?`, snapshot.GenerationID).Scan(&key); err != nil {
			return err
		}
		if len(key) != 64 {
			key = proposed
			if _, err := tx.ExecContext(ctx, `UPDATE recommendation_generation_profile SET profile_json=json_set(profile_json,'$.contextSigningKey',?) WHERE generation_id=?`, key, snapshot.GenerationID); err != nil {
				return err
			}
		}
		snapshot.contextSigningKey = key
		return nil
	})
	return snapshot, err
}

func recommendationInputRevision(ctx context.Context, queryer recommendationConfigQueryer) (int64, error) {
	var revision int64
	err := queryer.QueryRowContext(ctx, "SELECT revision FROM recommendation_input_revision WHERE id = 1").Scan(&revision)
	return revision, err
}

func recommendationUserRevision(ctx context.Context, queryer recommendationConfigQueryer, userID int64) (int64, error) {
	var revision int64
	err := queryer.QueryRowContext(ctx, "SELECT COALESCE((SELECT revision FROM recommendation_user_revision WHERE user_id = ?),0)", userID).Scan(&revision)
	return revision, err
}

func (s *Store) RecommendationSnapshotBreakdown(ctx context.Context, snapshot RecommendationSessionSnapshot, workID int64) (RecommendationBreakdown, error) {
	var exists bool
	if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM work WHERE id = ?)", workID).Scan(&exists); err != nil {
		return RecommendationBreakdown{}, err
	}
	if !exists {
		return RecommendationBreakdown{}, sql.ErrNoRows
	}
	scores, err := s.scoreRecommendationWorks(ctx, snapshot, []int64{workID})
	if err != nil {
		return RecommendationBreakdown{}, err
	}
	return scores[workID], nil
}

func (s *Store) RecommendationSnapshotScore(ctx context.Context, generationID, workID int64) (int, bool, error) {
	var snapshot RecommendationSessionSnapshot
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT user_id,catalog_epoch,config_json FROM recommendation_generation WHERE id = ? AND ready = 1 AND algorithm_version = ?", generationID, RecommendationAlgorithmVersion).Scan(&snapshot.UserID, &snapshot.CatalogEpoch, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	snapshot.GenerationID = generationID
	snapshot.Config, err = decodeRecommendationConfig(raw)
	if err != nil {
		return 0, false, err
	}
	breakdown, err := s.RecommendationSnapshotBreakdown(ctx, snapshot, workID)
	return breakdown.Score, err == nil, err
}
