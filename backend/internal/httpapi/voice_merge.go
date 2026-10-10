package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

func (s *Server) mergeVoicePeople(ctx context.Context, targetID int64, sourceID int64) (map[string]any, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	targetName, sourceName, mergeReviewID, err := prepareVoiceMergeReview(ctx, tx, targetID, sourceID)
	if err != nil {
		return nil, err
	}
	if err := mergeVoiceRelations(ctx, tx, targetID, sourceID, sourceName); err != nil {
		return nil, err
	}
	if err := deleteMergedVoicePerson(ctx, tx, sourceID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"mergeId": mergeReviewID, "targetPersonId": targetID, "sourcePersonId": sourceID, "targetName": targetName, "mergedName": sourceName}, nil
}

func prepareVoiceMergeReview(ctx context.Context, tx *sql.Tx, targetID, sourceID int64) (string, string, int64, error) {
	var targetName, sourceName string
	if err := tx.QueryRowContext(ctx, "SELECT display_name FROM person WHERE id = ?", targetID).Scan(&targetName); err != nil {
		return "", "", 0, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT display_name FROM person WHERE id = ?", sourceID).Scan(&sourceName); err != nil {
		return "", "", 0, err
	}
	snapshot, err := loadPersonMergeSnapshot(ctx, tx, targetID, sourceID)
	if err != nil {
		return "", "", 0, err
	}
	addedAliasSet := map[string]bool{sourceName: true}
	for _, alias := range snapshot.Aliases {
		addedAliasSet[alias.Alias] = true
	}
	for alias := range addedAliasSet {
		snapshot.AddedAliases = append(snapshot.AddedAliases, alias)
	}
	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		return "", "", 0, err
	}
	mergeReviewID, err := insertPersonMergeReview(ctx, tx, targetID, sourceID, targetName, sourceName, string(snapshotJSON))
	return targetName, sourceName, mergeReviewID, err
}

func mergeVoiceRelations(ctx context.Context, tx *sql.Tx, targetID, sourceID int64, sourceName string) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person_alias (person_id, alias, source)
		VALUES (?, ?, 'merged_name')
		ON CONFLICT(person_id, alias) DO NOTHING
	`, targetID, sourceName); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person_alias (person_id, alias, source)
		SELECT ?, alias, CASE WHEN source = 'primary_name' THEN 'merged_primary_name' ELSE 'merged_alias' END
		FROM person_alias
		WHERE person_id = ?
		ON CONFLICT(person_id, alias) DO NOTHING
	`, targetID, sourceID); err != nil {
		return err
	}
	// Provider identities follow the merge. Deleting the source person would
	// otherwise cascade them away, and the next sync that reports the same
	// remote voice actor id would recreate the merged-away person.
	if _, err := tx.ExecContext(ctx, `
		UPDATE person_external_id
		SET person_id = ?,
			is_primary = CASE WHEN EXISTS (
				SELECT 1 FROM person_external_id AS kept
				WHERE kept.person_id = ?
					AND kept.provider_id = person_external_id.provider_id
					AND kept.id_type = person_external_id.id_type
					AND kept.is_primary = 1
			) THEN 0 ELSE is_primary END
		WHERE person_id = ?
	`, targetID, targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_credit (work_id, person_id, role, provider_id, source, created_at, updated_at)
		SELECT work_id, ?, role, provider_id, source, created_at, CURRENT_TIMESTAMP
		FROM work_credit
		WHERE person_id = ?
		ON CONFLICT(work_id, person_id, role) DO UPDATE SET
			provider_id = COALESCE(excluded.provider_id, work_credit.provider_id),
			source = CASE WHEN work_credit.source = '' THEN excluded.source ELSE work_credit.source END,
			updated_at = CURRENT_TIMESTAMP
	`, targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_person_state (user_id, person_id, rating, note, favorite, last_viewed_at, created_at, updated_at)
		SELECT user_id, ?, rating, note, favorite, last_viewed_at, created_at, CURRENT_TIMESTAMP
		FROM user_person_state
		WHERE person_id = ?
		ON CONFLICT(user_id, person_id) DO UPDATE SET
			rating = COALESCE(user_person_state.rating, excluded.rating),
			note = CASE WHEN user_person_state.note = '' THEN excluded.note ELSE user_person_state.note END,
			favorite = CASE WHEN excluded.favorite = 1 THEN 1 ELSE user_person_state.favorite END,
			last_viewed_at = COALESCE(user_person_state.last_viewed_at, excluded.last_viewed_at),
			updated_at = CURRENT_TIMESTAMP
	`, targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_person_tag_assignment (user_id, person_id, user_person_tag_id, created_at)
		SELECT user_id, ?, user_person_tag_id, created_at
		FROM user_person_tag_assignment
		WHERE person_id = ?
		ON CONFLICT(user_id, person_id, user_person_tag_id) DO NOTHING
	`, targetID, sourceID); err != nil {
		return err
	}
	if err := mergeVoiceCatalogPeople(ctx, tx, targetID, sourceID); err != nil {
		return err
	}
	return nil
}

func deleteMergedVoicePerson(ctx context.Context, tx *sql.Tx, sourceID int64) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_credit WHERE person_id = ?", sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_state WHERE person_id = ?", sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_tag_assignment WHERE person_id = ?", sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM person_alias WHERE person_id = ?", sourceID); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, "DELETE FROM person WHERE id = ?", sourceID)
	if err != nil {
		return err
	}
	deleted, _ := result.RowsAffected()
	if deleted == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Server) undoVoiceMerge(ctx context.Context, targetID int64, mergeID int64) (map[string]any, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	record, err := loadVoiceMergeUndoRecord(ctx, tx, targetID, mergeID)
	if err != nil {
		return nil, err
	}
	if err := restoreVoiceMergeSnapshot(ctx, tx, targetID, record.snapshot); err != nil {
		return nil, err
	}
	if err := markVoiceMergeUndone(ctx, tx, targetID, mergeID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"mergeId": mergeID, "targetPersonId": targetID, "restoredPersonId": record.snapshot.SourcePerson.ID, "restoredName": record.sourceName}, nil
}

type voiceMergeUndoRecord struct {
	snapshot   personMergeSnapshot
	sourceName string
}

func loadVoiceMergeUndoRecord(ctx context.Context, tx *sql.Tx, targetID, mergeID int64) (voiceMergeUndoRecord, error) {
	var record voiceMergeUndoRecord
	var snapshotRaw, status string
	if err := tx.QueryRowContext(ctx, `
		SELECT snapshot_json, status, source_name
		FROM person_merge_review
		WHERE id = ? AND target_person_id = ?
	`, mergeID, targetID).Scan(&snapshotRaw, &status, &record.sourceName); err != nil {
		return record, err
	}
	if status != "merged" {
		return record, fmt.Errorf("merge review is already %s", status)
	}
	if err := json.Unmarshal([]byte(snapshotRaw), &record.snapshot); err != nil {
		return record, err
	}
	return record, nil
}

func restoreVoiceMergeSnapshot(ctx context.Context, tx *sql.Tx, targetID int64, snapshot personMergeSnapshot) error {
	if err := restoreVoiceMergePerson(ctx, tx, snapshot); err != nil {
		return err
	}
	if err := restoreVoiceMergeExternalIDs(ctx, tx, targetID, snapshot); err != nil {
		return err
	}
	if err := restoreVoiceMergeCredits(ctx, tx, targetID, snapshot); err != nil {
		return err
	}
	if err := restoreVoiceMergeStates(ctx, tx, targetID, snapshot); err != nil {
		return err
	}
	if err := restoreVoiceMergeTags(ctx, tx, targetID, snapshot); err != nil {
		return err
	}
	for _, alias := range snapshot.AddedAliases {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM person_alias
			WHERE person_id = ?
				AND alias = ?
				AND source IN ('merged_name', 'merged_primary_name', 'merged_alias')
		`, targetID, alias); err != nil {
			return err
		}
	}
	if snapshot.CatalogCaptured {
		return restoreVoiceCatalogMergeSnapshot(ctx, tx, targetID, snapshot.SourcePerson.ID, snapshot.TargetCatalog, snapshot.SourceCatalog)
	}
	return nil
}

func restoreVoiceMergePerson(ctx context.Context, tx *sql.Tx, snapshot personMergeSnapshot) error {
	person := snapshot.SourcePerson
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person (id, display_name, sort_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			display_name = excluded.display_name,
			sort_name = excluded.sort_name,
			updated_at = CURRENT_TIMESTAMP
	`, person.ID, person.DisplayName, person.SortName, person.CreatedAt, person.UpdatedAt); err != nil {
		return err
	}
	for _, alias := range snapshot.Aliases {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO person_alias (person_id, alias, source, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(person_id, alias) DO NOTHING
		`, person.ID, alias.Alias, alias.Source, alias.CreatedAt); err != nil {
			return err
		}
	}
	return nil
}

// restoreVoiceMergeExternalIDs returns the provider identities the merge
// moved. An identity a later sync attached to some other person stays there.
func restoreVoiceMergeExternalIDs(ctx context.Context, tx *sql.Tx, targetID int64, snapshot personMergeSnapshot) error {
	for _, item := range snapshot.ExternalIDs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
				person_id = excluded.person_id,
				is_primary = excluded.is_primary
			WHERE person_external_id.person_id = ?
		`, snapshot.SourcePerson.ID, item.ProviderID, item.IDType, item.ExternalID, item.IsPrimary, targetID); err != nil {
			return err
		}
	}
	return nil
}

func restoreVoiceMergeCredits(ctx context.Context, tx *sql.Tx, targetID int64, snapshot personMergeSnapshot) error {
	for _, credit := range snapshot.Credits {
		var provider any
		if credit.ProviderID != nil {
			provider = *credit.ProviderID
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_credit (work_id, person_id, role, provider_id, source, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(work_id, person_id, role) DO UPDATE SET
				provider_id = excluded.provider_id,
				source = excluded.source,
				updated_at = CURRENT_TIMESTAMP
		`, credit.WorkID, snapshot.SourcePerson.ID, credit.Role, provider, credit.Source, credit.CreatedAt, credit.UpdatedAt); err != nil {
			return err
		}
	}
	targetCreditKeys := make(map[string]bool, len(snapshot.TargetCredits))
	for _, credit := range snapshot.TargetCredits {
		targetCreditKeys[workCreditKey(credit.WorkID, credit.Role)] = true
	}
	for _, credit := range snapshot.Credits {
		if targetCreditKeys[workCreditKey(credit.WorkID, credit.Role)] {
			continue
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM work_credit WHERE work_id = ? AND person_id = ? AND role = ?", credit.WorkID, targetID, credit.Role); err != nil {
			return err
		}
	}
	return nil
}

func restoreVoiceMergeStates(ctx context.Context, tx *sql.Tx, targetID int64, snapshot personMergeSnapshot) error {
	for _, state := range snapshot.States {
		if err := restoreUserPersonState(ctx, tx, snapshot.SourcePerson.ID, state); err != nil {
			return err
		}
	}
	targetStateUsers := make(map[int64]bool, len(snapshot.TargetStates))
	for _, state := range snapshot.TargetStates {
		targetStateUsers[state.UserID] = true
		if err := restoreUserPersonState(ctx, tx, targetID, state); err != nil {
			return err
		}
	}
	for _, state := range snapshot.States {
		if targetStateUsers[state.UserID] {
			continue
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_state WHERE user_id = ? AND person_id = ?", state.UserID, targetID); err != nil {
			return err
		}
	}
	return nil
}

func restoreVoiceMergeTags(ctx context.Context, tx *sql.Tx, targetID int64, snapshot personMergeSnapshot) error {
	for _, link := range snapshot.TagLinks {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_person_tag_assignment (user_id, person_id, user_person_tag_id, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, person_id, user_person_tag_id) DO NOTHING
		`, link.UserID, snapshot.SourcePerson.ID, link.UserPersonTagID, link.CreatedAt); err != nil {
			return err
		}
	}
	targetTagKeys := make(map[string]bool, len(snapshot.TargetTagLinks))
	for _, link := range snapshot.TargetTagLinks {
		targetTagKeys[userTagLinkKey(link.UserID, link.UserPersonTagID)] = true
	}
	for _, link := range snapshot.TagLinks {
		if targetTagKeys[userTagLinkKey(link.UserID, link.UserPersonTagID)] {
			continue
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_tag_assignment WHERE user_id = ? AND person_id = ? AND user_person_tag_id = ?", link.UserID, targetID, link.UserPersonTagID); err != nil {
			return err
		}
	}
	return nil
}

func markVoiceMergeUndone(ctx context.Context, tx *sql.Tx, targetID, mergeID int64) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE person_merge_review
		SET status = 'undone',
			undone_at = CURRENT_TIMESTAMP
		WHERE id = ? AND target_person_id = ? AND status = 'merged'
	`, mergeID, targetID)
	return err
}

func insertPersonMergeReview(ctx context.Context, tx *sql.Tx, targetID int64, sourceID int64, targetName string, sourceName string, snapshotJSON string) (int64, error) {
	result, err := tx.ExecContext(ctx, `
		INSERT INTO person_merge_review (target_person_id, source_person_id, target_name, source_name, snapshot_json)
		VALUES (?, ?, ?, ?, ?)
	`, targetID, sourceID, targetName, sourceName, snapshotJSON)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func loadPersonMergeSnapshot(ctx context.Context, tx *sql.Tx, targetID int64, personID int64) (personMergeSnapshot, error) {
	sourcePerson, err := loadPersonSnapshot(ctx, tx, personID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	aliases, err := loadPersonAliasSnapshots(ctx, tx, personID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	credits, err := loadWorkCreditSnapshots(ctx, tx, personID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	states, err := loadUserPersonStateSnapshots(ctx, tx, personID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	links, err := loadUserPersonTagLinkSnapshots(ctx, tx, personID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	externalIDs, err := loadPersonExternalIDSnapshots(ctx, tx, personID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	targetCredits, err := loadWorkCreditSnapshots(ctx, tx, targetID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	targetStates, err := loadUserPersonStateSnapshots(ctx, tx, targetID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	targetLinks, err := loadUserPersonTagLinkSnapshots(ctx, tx, targetID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	sourceCatalog, err := loadVoiceCatalogPersonSnapshot(ctx, tx, personID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	targetCatalog, err := loadVoiceCatalogPersonSnapshot(ctx, tx, targetID)
	if err != nil {
		return personMergeSnapshot{}, err
	}
	return personMergeSnapshot{
		SourcePerson:    sourcePerson,
		Aliases:         aliases,
		Credits:         credits,
		States:          states,
		TagLinks:        links,
		ExternalIDs:     externalIDs,
		TargetCredits:   targetCredits,
		TargetStates:    targetStates,
		TargetTagLinks:  targetLinks,
		CatalogCaptured: true,
		SourceCatalog:   sourceCatalog,
		TargetCatalog:   targetCatalog,
	}, nil
}

func loadPersonSnapshot(ctx context.Context, tx *sql.Tx, personID int64) (personSnapshot, error) {
	var person personSnapshot
	err := tx.QueryRowContext(ctx, `
		SELECT id, display_name, sort_name, created_at, updated_at
		FROM person
		WHERE id = ?
	`, personID).Scan(&person.ID, &person.DisplayName, &person.SortName, &person.CreatedAt, &person.UpdatedAt)
	return person, err
}

func loadPersonAliasSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]personAliasSnapshot, error) {
	rows, err := tx.QueryContext(ctx, "SELECT alias, source, created_at FROM person_alias WHERE person_id = ? ORDER BY id ASC", personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []personAliasSnapshot{}
	for rows.Next() {
		var item personAliasSnapshot
		if err := rows.Scan(&item.Alias, &item.Source, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadPersonExternalIDSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]personExternalIDSnapshot, error) {
	rows, err := tx.QueryContext(ctx, "SELECT provider_id, id_type, external_id, is_primary FROM person_external_id WHERE person_id = ? ORDER BY id ASC", personID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []personExternalIDSnapshot{}
	for rows.Next() {
		var item personExternalIDSnapshot
		if err := rows.Scan(&item.ProviderID, &item.IDType, &item.ExternalID, &item.IsPrimary); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadWorkCreditSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]workCreditSnapshot, error) {
	rows, err := tx.QueryContext(ctx, "SELECT work_id, role, provider_id, source, created_at, updated_at FROM work_credit WHERE person_id = ? ORDER BY work_id ASC", personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []workCreditSnapshot{}
	for rows.Next() {
		var item workCreditSnapshot
		var provider sql.NullInt64
		if err := rows.Scan(&item.WorkID, &item.Role, &provider, &item.Source, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if provider.Valid {
			value := provider.Int64
			item.ProviderID = &value
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadUserPersonStateSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]userPersonStateSnapshot, error) {
	rows, err := tx.QueryContext(ctx, "SELECT user_id, rating, note, favorite, last_viewed_at, created_at, updated_at FROM user_person_state WHERE person_id = ? ORDER BY user_id ASC", personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []userPersonStateSnapshot{}
	for rows.Next() {
		var item userPersonStateSnapshot
		var rating sql.NullInt64
		var favorite int
		var lastViewed sql.NullString
		if err := rows.Scan(&item.UserID, &rating, &item.Note, &favorite, &lastViewed, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if rating.Valid {
			value := int(rating.Int64)
			item.Rating = &value
		}
		item.Favorite = favorite != 0
		if lastViewed.Valid {
			value := lastViewed.String
			item.LastViewedAt = &value
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadUserPersonTagLinkSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]userPersonTagLinkSnapshot, error) {
	rows, err := tx.QueryContext(ctx, "SELECT user_id, user_person_tag_id, created_at FROM user_person_tag_assignment WHERE person_id = ? ORDER BY user_id ASC, user_person_tag_id ASC", personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []userPersonTagLinkSnapshot{}
	for rows.Next() {
		var item userPersonTagLinkSnapshot
		if err := rows.Scan(&item.UserID, &item.UserPersonTagID, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func restoreUserPersonState(ctx context.Context, tx *sql.Tx, personID int64, state userPersonStateSnapshot) error {
	var rating any
	if state.Rating != nil {
		rating = *state.Rating
	}
	var lastViewed any
	if state.LastViewedAt != nil {
		lastViewed = *state.LastViewedAt
	}
	favorite := 0
	if state.Favorite {
		favorite = 1
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO user_person_state (user_id, person_id, rating, note, favorite, last_viewed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, person_id) DO UPDATE SET
			rating = excluded.rating,
			note = excluded.note,
			favorite = excluded.favorite,
			last_viewed_at = excluded.last_viewed_at,
			updated_at = CURRENT_TIMESTAMP
	`, state.UserID, personID, rating, state.Note, favorite, lastViewed, state.CreatedAt, state.UpdatedAt)
	return err
}

func workCreditKey(workID int64, role string) string {
	return fmt.Sprintf("%d:%s", workID, role)
}

func userTagLinkKey(userID int64, tagID int64) string {
	return fmt.Sprintf("%d:%d", userID, tagID)
}

func aliasNames(aliases []voiceAlias) []string {
	names := []string{}
	for _, alias := range aliases {
		names = append(names, alias.Alias)
	}
	return names
}
