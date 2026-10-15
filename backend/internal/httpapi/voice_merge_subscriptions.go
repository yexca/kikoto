package httpapi

import (
	"context"
	"database/sql"
)

// A voice actor merge keeps every account's subscription on the target and
// unions the seen sets, so merged catalogs never report known works as new.
// Undo restores both sides' subscriptions and the source's seen set.

type personSubscriptionSnapshot struct {
	UserID            int64   `json:"userId"`
	WatchAvailability bool    `json:"watchAvailability"`
	ActivatedAt       *string `json:"activatedAt"`
	CreatedAt         string  `json:"createdAt"`
}

func loadPersonSubscriptionSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]personSubscriptionSnapshot, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT user_id, watch_availability, activated_at, created_at
		FROM creator_subscription WHERE person_id = ? ORDER BY user_id
	`, personID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []personSubscriptionSnapshot{}
	for rows.Next() {
		var item personSubscriptionSnapshot
		var activatedAt sql.NullString
		if err := rows.Scan(&item.UserID, &item.WatchAvailability, &activatedAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		if activatedAt.Valid {
			item.ActivatedAt = &activatedAt.String
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadPersonReleaseSeen(ctx context.Context, tx *sql.Tx, personID int64) ([]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT primary_code FROM person_release_seen WHERE person_id = ? ORDER BY primary_code", personID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, rows.Err()
}

func capturePersonSubscriptions(ctx context.Context, tx *sql.Tx, snapshot *personMergeSnapshot, targetID, sourceID int64) error {
	var err error
	if snapshot.SourceSubscriptions, err = loadPersonSubscriptionSnapshots(ctx, tx, sourceID); err != nil {
		return err
	}
	if snapshot.TargetSubscriptions, err = loadPersonSubscriptionSnapshots(ctx, tx, targetID); err != nil {
		return err
	}
	if snapshot.SourceReleaseSeen, err = loadPersonReleaseSeen(ctx, tx, sourceID); err != nil {
		return err
	}
	snapshot.SubscriptionsCaptured = true
	return nil
}

func mergePersonSubscriptions(ctx context.Context, tx *sql.Tx, targetID, sourceID int64) error {
	queries := []string{
		`INSERT INTO creator_subscription (user_id, subject_kind, person_id, watch_availability, activated_at, created_at)
		SELECT user_id, 'voice', ?, watch_availability, activated_at, created_at
		FROM creator_subscription WHERE person_id = ?
		ON CONFLICT(user_id, person_id) WHERE person_id IS NOT NULL DO UPDATE SET
			watch_availability = MAX(creator_subscription.watch_availability, excluded.watch_availability),
			activated_at = COALESCE(creator_subscription.activated_at, excluded.activated_at)`,
		`INSERT OR IGNORE INTO person_release_seen (person_id, primary_code, seen_at)
		SELECT ?, primary_code, seen_at FROM person_release_seen WHERE person_id = ?`,
		`UPDATE user_release_feed_item SET person_id = ? WHERE person_id = ?`,
	}
	for _, query := range queries {
		if _, err := tx.ExecContext(ctx, query, targetID, sourceID); err != nil {
			return err
		}
	}
	for _, query := range []string{
		"DELETE FROM creator_subscription WHERE person_id = ?",
		"DELETE FROM person_release_seen WHERE person_id = ?",
	} {
		if _, err := tx.ExecContext(ctx, query, sourceID); err != nil {
			return err
		}
	}
	return nil
}

func restorePersonSubscriptions(ctx context.Context, tx *sql.Tx, targetID int64, snapshot personMergeSnapshot) error {
	if !snapshot.SubscriptionsCaptured {
		return nil
	}
	sourceID := snapshot.SourcePerson.ID
	if _, err := tx.ExecContext(ctx, "DELETE FROM creator_subscription WHERE person_id IN (?, ?)", targetID, sourceID); err != nil {
		return err
	}
	restore := func(personID int64, items []personSubscriptionSnapshot) error {
		for _, item := range items {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO creator_subscription (user_id, subject_kind, person_id, watch_availability, activated_at, created_at)
				VALUES (?, 'voice', ?, ?, ?, ?)
			`, item.UserID, personID, item.WatchAvailability, item.ActivatedAt, item.CreatedAt); err != nil {
				return err
			}
		}
		return nil
	}
	if err := restore(targetID, snapshot.TargetSubscriptions); err != nil {
		return err
	}
	if err := restore(sourceID, snapshot.SourceSubscriptions); err != nil {
		return err
	}
	for _, code := range snapshot.SourceReleaseSeen {
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO person_release_seen (person_id, primary_code) VALUES (?, ?)", sourceID, code); err != nil {
			return err
		}
	}
	return nil
}
