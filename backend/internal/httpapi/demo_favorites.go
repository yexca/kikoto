package httpapi

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/contentpolicy"
)

// Demo favorites are disposable presentation data owned by the read-only Demo
// account. Refreshing them after admission avoids retaining stale associations.
func seedDemoFavorites(ctx context.Context, tx *sql.Tx) error {
	var userID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM user_account WHERE username = ?", account.DemoUsername).Scan(&userID); err != nil {
		return fmt.Errorf("find demo account: %w", err)
	}
	for _, query := range []string{
		"DELETE FROM favorite_list WHERE user_id = ? AND kind = 'user'",
		"DELETE FROM user_work_state WHERE user_id = ?",
		"DELETE FROM user_person_state WHERE user_id = ?",
		"DELETE FROM user_party_state WHERE user_id = ?",
	} {
		if _, err := tx.ExecContext(ctx, query, userID); err != nil {
			return err
		}
	}

	// A local presence alone is insufficient: the work must also pass Demo's
	// all-age, permanently-free policy before it can appear on a personal shelf.
	eligibleWork := contentpolicy.DemoEligibleWorkSQL("work") + `
		AND EXISTS (SELECT 1 FROM work_source_presence AS presence
			JOIN file_source AS source ON source.id = presence.file_source_id
			WHERE presence.work_id = work.id AND presence.presence_type = 'local'
				AND presence.availability = 'available' AND source.source_type = 'local_folder')`
	workIDs, err := demoRandomIDs(ctx, tx, "SELECT work.id FROM work WHERE "+eligibleWork+" ORDER BY RANDOM() LIMIT 12")
	if err != nil {
		return err
	}
	for index, workID := range workIDs {
		if index >= 5 {
			break
		}
		status := []string{"want_to_listen", "listening", "finished"}[index%3]
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_work_state (user_id, work_id, listening_status)
			VALUES (?, ?, ?)`, userID, workID, status); err != nil {
			return err
		}
	}
	if len(workIDs) > 0 {
		listNames := []string{"Weekend Picks", "On Repeat"}
		listCount := 1
		if len(workIDs) >= 4 {
			listCount = 2
		}
		for index := 0; index < listCount; index++ {
			result, err := tx.ExecContext(ctx, `INSERT INTO favorite_list (user_id, name, sort_order, kind)
				VALUES (?, ?, ?, 'user')`, userID, listNames[index], index)
			if err != nil {
				return err
			}
			listID, err := result.LastInsertId()
			if err != nil {
				return err
			}
			count := len(workIDs)
			if count > 5 {
				count = 5
			}
			for position := 0; position < count; position++ {
				workID := workIDs[(position+index*3)%len(workIDs)]
				if _, err := tx.ExecContext(ctx, `INSERT INTO favorite_list_item (list_id, work_id, sort_order)
					VALUES (?, ?, ?)`, listID, workID, position); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO user_work_state (user_id, work_id, favorite)
					VALUES (?, ?, 1) ON CONFLICT(user_id, work_id) DO UPDATE SET favorite = 1`, userID, workID); err != nil {
					return err
				}
			}
		}
	}

	personIDs, err := demoRandomIDs(ctx, tx, `SELECT DISTINCT person.id FROM person
		JOIN work_credit AS credit ON credit.person_id = person.id AND credit.role = 'voice_actor'
		JOIN work ON work.id = credit.work_id
		WHERE `+eligibleWork+` ORDER BY RANDOM() LIMIT 4`)
	if err != nil {
		return err
	}
	for _, personID := range personIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_person_state (user_id, person_id, favorite)
			VALUES (?, ?, 1)`, userID, personID); err != nil {
			return err
		}
	}
	partyIDs, err := demoRandomIDs(ctx, tx, `SELECT DISTINCT party.id FROM party
		JOIN work_party AS relation ON relation.party_id = party.id AND relation.role = 'circle'
		JOIN work ON work.id = relation.work_id
		WHERE `+eligibleWork+` ORDER BY RANDOM() LIMIT 4`)
	if err != nil {
		return err
	}
	for _, partyID := range partyIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_party_state (user_id, party_id, favorite)
			VALUES (?, ?, 1)`, userID, partyID); err != nil {
			return err
		}
	}
	return nil
}

func demoRandomIDs(ctx context.Context, tx *sql.Tx, query string) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
