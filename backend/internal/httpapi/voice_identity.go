package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

type voiceCreditSnapshotRow struct {
	WorkID     int64
	ProviderID sql.NullInt64
	Raw        string
}

// syncVoiceCreditSnapshot projects a snapshot's voice credits inside a
// caller's transaction, such as a remote work being persisted.
func syncVoiceCreditSnapshot(ctx context.Context, tx *sql.Tx, snapshot voiceCreditSnapshotRow) error {
	return writeVoiceCredits(ctx, tx, snapshot.WorkID, snapshot.ProviderID, voiceCreditActors(snapshot.Raw))
}

// voiceCreditActors returns the distinct voice actors a snapshot credits, with
// the provider's id for each when it publishes one, or the unknown voice actor
// when it names none.
func voiceCreditActors(raw string) []voiceActorIdentity {
	actors := parseDLsiteSnapshot(raw).VoiceActorIdentities
	if len(actors) == 0 {
		actors = parseKikoeruVoiceActorIdentities(raw)
	}
	if len(actors) == 0 {
		actors = []voiceActorIdentity{{Name: unknownVoiceActorName}}
	}
	distinct := make([]voiceActorIdentity, 0, len(actors))
	seenActor := map[string]bool{}
	for _, actor := range actors {
		actor.Name = strings.TrimSpace(actor.Name)
		if actor.Name == "" || seenActor[voiceNameKey(actor.Name)] {
			continue
		}
		seenActor[voiceNameKey(actor.Name)] = true
		distinct = append(distinct, actor)
	}
	return distinct
}

// withoutRedundantUnknownVoiceActor drops the unknown voice actor from one of
// two snapshots of a work when the other names a voice actor, so the work is
// not credited to the unknown voice actor beside a known one.
func withoutRedundantUnknownVoiceActor(first, second []voiceActorIdentity) ([]voiceActorIdentity, []voiceActorIdentity) {
	unknownOnly := func(actors []voiceActorIdentity) bool {
		return len(actors) == 1 && isUnknownVoiceActorName(actors[0].Name)
	}
	switch {
	case unknownOnly(first) && !unknownOnly(second):
		return nil, second
	case unknownOnly(second) && !unknownOnly(first):
		return first, nil
	}
	return first, second
}

// writeVoiceCredits adds the credits without removing ones the snapshot no
// longer names, except an earlier credit of the same provider voice actor
// under another person (see upsertPersonIdentity) and the unknown voice actor,
// whose snapshot credit goes once the work credits a real voice actor. A
// credit that already matches is left untouched, so it does not advance the
// recommendation revision.
func writeVoiceCredits(ctx context.Context, tx *sql.Tx, workID int64, providerID sql.NullInt64, actors []voiceActorIdentity) error {
	var provider any
	if providerID.Valid {
		provider = providerID.Int64
	}
	translation, err := workIsTranslationEdition(ctx, tx, workID)
	if err != nil {
		return err
	}
	// A snapshot naming no voice actor adds the unknown voice actor only to a
	// work that credits no real one, rather than adding it to remove it again.
	if len(actors) == 1 && isUnknownVoiceActorName(actors[0].Name) {
		credited, err := creditsRealVoiceActor(ctx, tx, workID)
		if err != nil {
			return err
		}
		if credited {
			return nil
		}
	}
	for _, actor := range actors {
		personID, err := upsertPersonIdentity(ctx, tx, voiceCreditTarget{WorkID: workID, Translation: translation}, actor.Name, providerID, actor.ExternalID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_credit (work_id, person_id, role, provider_id, source, updated_at)
			VALUES (?, ?, 'voice_actor', ?, 'metadata_snapshot', CURRENT_TIMESTAMP)
			ON CONFLICT(work_id, person_id, role) DO UPDATE SET
				provider_id = excluded.provider_id,
				source = excluded.source,
				updated_at = CURRENT_TIMESTAMP
			WHERE work_credit.provider_id IS NOT excluded.provider_id
				OR work_credit.source IS NOT excluded.source
		`, workID, personID, provider); err != nil {
			return err
		}
	}
	return dropUnknownVoiceCreditBesideKnown(ctx, tx, workID)
}

// dropUnknownVoiceCreditBesideKnown removes the unknown voice actor's snapshot
// credit from a work that credits a real voice actor, as an earlier snapshot
// that named none leaves it.
// Both lookups read only the work's own credits, so neither scans every
// person.
func dropUnknownVoiceCreditBesideKnown(ctx context.Context, tx *sql.Tx, workID int64) error {
	_, err := tx.ExecContext(ctx, `
		DELETE FROM work_credit
		WHERE work_id = ? AND role = 'voice_actor' AND source <> 'manual_override'
			AND person_id IN (
				SELECT credit.person_id FROM work_credit AS credit
				INNER JOIN person ON person.id = credit.person_id
				WHERE credit.work_id = ? AND credit.role = 'voice_actor'
					AND LOWER(TRIM(person.display_name)) = LOWER(?)
			)
			AND EXISTS (
				SELECT 1 FROM work_credit AS known
				INNER JOIN person ON person.id = known.person_id
				WHERE known.work_id = ? AND known.role = 'voice_actor'
					AND LOWER(TRIM(person.display_name)) <> LOWER(?)
			)
	`, workID, workID, unknownVoiceActorName, workID, unknownVoiceActorName)
	return err
}

// creditsRealVoiceActor reports whether the work credits a voice actor other
// than the unknown voice actor.
func creditsRealVoiceActor(ctx context.Context, tx *sql.Tx, workID int64) (bool, error) {
	var credited bool
	err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM work_credit AS credit
			INNER JOIN person ON person.id = credit.person_id
			WHERE credit.work_id = ? AND credit.role = 'voice_actor'
				AND LOWER(TRIM(person.display_name)) <> LOWER(?)
		)
	`, workID, unknownVoiceActorName).Scan(&credited)
	return credited, err
}

type voiceActorIdentity struct {
	Name       string
	ExternalID string
}

// voiceCreditTarget is the work whose snapshot names a voice actor.
// Translation is true for a translated edition, whose spelling of a voice
// actor's name names the person only while no original edition credits them.
type voiceCreditTarget struct {
	WorkID      int64
	Translation bool
}

// translationEditionSQL matches a work that is a non-canonical edition of its
// family, given the expression for its work id.
const translationEditionSQL = `EXISTS (
	SELECT 1 FROM work_edition AS edition
	INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
	WHERE edition.work_id = %s AND edition.is_canonical = 0
		AND COALESCE(logical.canonical_work_id, 0) <> edition.work_id
)`

func workIsTranslationEdition(ctx context.Context, tx *sql.Tx, workID int64) (bool, error) {
	var translation bool
	err := tx.QueryRowContext(ctx, "SELECT "+fmt.Sprintf(translationEditionSQL, "?"), workID).Scan(&translation)
	return translation, err
}

// upsertPersonIdentity resolves the person a snapshot credits. A provider
// voice actor id resolves to the person that carries it; the id, not the
// name, is the voice actor's identity, and two people may share a name. An id
// seen for the first time binds to the one person of that name who carries no
// id of the provider, the voice actor credited by name before the id was
// known; with no such person, or several, it gets a new person with the
// plain name, so it never binds to a namesake who carries another id of the
// provider. A known id's person absorbs the one person of its spelling that
// is the same voice actor credited by name, through a recorded, undoable
// merge; one that carries another id of the provider, was separated again by
// undoing such a merge, or is named by a manual override stays a separate
// person, and the latter only loses its metadata credit on this work. Several
// such candidates are ambiguous and none is merged. The person follows the
// provider's spelling on an original edition, and on a translated edition
// only while no original edition credits them, so a translation's spelling
// becomes an alias. A name an administrator merged into the person never
// replaces the display name they kept.
func upsertPersonIdentity(ctx context.Context, tx *sql.Tx, target voiceCreditTarget, name string, providerID sql.NullInt64, externalID string) (int64, error) {
	externalID = strings.TrimSpace(externalID)
	name = strings.TrimSpace(name)
	if !providerID.Valid || externalID == "" {
		return upsertPerson(ctx, tx, name)
	}
	var personID int64
	err := tx.QueryRowContext(ctx, `
		SELECT person_id FROM person_external_id
		WHERE provider_id = ? AND id_type = 'voice_actor_id' AND external_id = ?
	`, providerID.Int64, externalID).Scan(&personID)
	if errors.Is(err, sql.ErrNoRows) {
		personID, err = personForNewProviderID(ctx, tx, name, providerID.Int64)
		if err != nil {
			return 0, err
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary)
			VALUES (?, ?, 'voice_actor_id', ?, 1)
			ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET person_id = excluded.person_id
		`, personID, providerID.Int64, externalID)
		return personID, err
	}
	if err != nil {
		return 0, err
	}

	namesakes, err := personsNamed(ctx, tx, name, providerID.Int64)
	if err != nil {
		return 0, err
	}
	var mergeID int64
	mergeCandidates := 0
	// Another namesake this provider identifies makes the spelling ambiguous:
	// a person credited by that name may be either voice actor.
	identifiedNamesake := false
	dropCredits := []int64{}
	for _, other := range namesakes {
		if other.id == personID {
			continue
		}
		if other.carriesProvider {
			identifiedNamesake = true
		}
		merge, dropCredit, err := identityMergeAllowed(ctx, tx, providerID.Int64, personID, other.id)
		if err != nil {
			return 0, err
		}
		// A person made for an ambiguous name never absorbs an id.
		if merge && !other.ambiguous {
			mergeID = other.id
			mergeCandidates++
		}
		if dropCredit {
			dropCredits = append(dropCredits, other.id)
		}
	}
	if mergeCandidates != 1 || identifiedNamesake {
		mergeID = 0
	}
	names := true
	if target.Translation {
		credited, err := creditedOnOriginalEdition(ctx, tx, providerID.Int64, personID, mergeID)
		if err != nil {
			return 0, err
		}
		names = !credited
	}
	if mergeID != 0 {
		// The person keeping the snapshot's spelling survives when that
		// spelling names the voice actor, unless an administrator merged that
		// name into the person carrying the id.
		keep, merged := personID, mergeID
		if names {
			adminKept, err := personHasAdministratorMergedName(ctx, tx, personID, name)
			if err != nil {
				return 0, err
			}
			if !adminKept {
				keep, merged = mergeID, personID
			}
		}
		if _, _, _, err := mergeVoicePeopleInTx(ctx, tx, keep, merged, identityVoiceMergeAliases); err != nil {
			return 0, err
		}
		personID = keep
	}
	for _, otherID := range dropCredits {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM work_credit
			WHERE work_id = ? AND person_id = ? AND role = 'voice_actor' AND source <> 'manual_override'
		`, target.WorkID, otherID); err != nil {
			return 0, err
		}
	}
	if names {
		if _, err := tx.ExecContext(ctx, `
			UPDATE person
			SET display_name = ?, sort_name = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND (display_name IS NOT ? OR sort_name IS NOT ?) AND NOT EXISTS (
				SELECT 1 FROM person_alias AS merged
				WHERE merged.person_id = ? AND merged.alias = ?
					AND merged.source IN ('merged_name', 'merged_primary_name', 'merged_alias')
			)
		`, name, strings.ToLower(name), personID, name, strings.ToLower(name), personID, name); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person_alias (person_id, alias, source)
		VALUES (?, ?, 'external_identity')
		ON CONFLICT(person_id, alias) DO NOTHING
	`, personID, name); err != nil {
		return 0, err
	}
	return personID, nil
}

// namedPerson is a person whose display name is a credited name, whether it
// carries a voice actor id of the crediting provider or of any provider, and
// whether it was made for a name several identified people hold.
type namedPerson struct {
	id              int64
	carriesProvider bool
	carriesAnyID    bool
	ambiguous       bool
}

func personsNamed(ctx context.Context, tx *sql.Tx, name string, providerID int64) ([]namedPerson, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT person.id,
			EXISTS (SELECT 1 FROM person_external_id AS external
				WHERE external.person_id = person.id AND external.id_type = 'voice_actor_id' AND external.provider_id = ?),
			EXISTS (SELECT 1 FROM person_external_id AS external
				WHERE external.person_id = person.id AND external.id_type = 'voice_actor_id'),
			person.ambiguous_name
		FROM person WHERE person.display_name = ?
		ORDER BY person.id ASC
	`, providerID, name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	people := []namedPerson{}
	for rows.Next() {
		var person namedPerson
		if err := rows.Scan(&person.id, &person.carriesProvider, &person.carriesAnyID, &person.ambiguous); err != nil {
			return nil, err
		}
		people = append(people, person)
	}
	return people, rows.Err()
}

// onlyOne returns the id of the single person the filter keeps, or 0 when it
// keeps none or several.
func onlyOne(people []namedPerson, keep func(namedPerson) bool) int64 {
	var id int64
	count := 0
	for _, person := range people {
		if keep(person) {
			id = person.id
			count++
		}
	}
	if count != 1 {
		return 0
	}
	return id
}

// personForNewProviderID chooses the person a provider voice actor id seen
// for the first time binds to: the one person of that name, or else of that
// confirmed alias, who carries no id of the provider, preferring among several
// the one person who carries no id at all. A person made for an ambiguous name
// never takes an id. Anything else gets a new person with the plain name.
func personForNewProviderID(ctx context.Context, tx *sql.Tx, name string, providerID int64) (int64, error) {
	namesakes, err := personsNamed(ctx, tx, name, providerID)
	if err != nil {
		return 0, err
	}
	if len(namesakes) == 0 {
		id, found, err := personForConfirmedAlias(ctx, tx, name)
		if err != nil {
			return 0, err
		}
		if found {
			var carries, ambiguous bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM person_external_id
				WHERE person_id = ? AND provider_id = ? AND id_type = 'voice_actor_id'),
				(SELECT ambiguous_name FROM person WHERE id = ?)`, id, providerID, id).Scan(&carries, &ambiguous); err != nil {
				return 0, err
			}
			if !carries && !ambiguous {
				return id, nil
			}
		}
		return insertPerson(ctx, tx, name, false)
	}
	if id := onlyOne(namesakes, func(person namedPerson) bool { return !person.carriesProvider && !person.ambiguous }); id != 0 {
		return id, nil
	}
	if id := onlyOne(namesakes, func(person namedPerson) bool { return !person.carriesAnyID && !person.ambiguous }); id != 0 {
		return id, nil
	}
	return insertPerson(ctx, tx, name, false)
}

// creditedOnOriginalEdition reports whether a snapshot of the provider
// credits either person on a work that is not a translated edition.
func creditedOnOriginalEdition(ctx context.Context, tx *sql.Tx, providerID, personID, otherID int64) (bool, error) {
	var credited bool
	err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM work_credit AS credit
			WHERE credit.person_id IN (?, ?) AND credit.role = 'voice_actor'
				AND credit.source = 'metadata_snapshot' AND credit.provider_id = ?
				AND NOT `+fmt.Sprintf(translationEditionSQL, "credit.work_id")+`
		)
	`, personID, otherID, providerID).Scan(&credited)
	return credited, err
}

// identityMergeAllowed reports whether the other person may be merged into
// the person carrying a provider voice actor id, or else whether only its
// metadata credit on the projected work goes.
func identityMergeAllowed(ctx context.Context, tx *sql.Tx, providerID, personID, otherID int64) (merge bool, dropCredit bool, err error) {
	var otherIdentity, undone, manual bool
	if err := tx.QueryRowContext(ctx, `
		SELECT
			EXISTS (
				SELECT 1 FROM person_external_id
				WHERE person_id = ? AND provider_id = ? AND id_type = 'voice_actor_id'
			),
			EXISTS (
				SELECT 1 FROM person_merge_review
				WHERE status = 'undone' AND (
					(target_person_id = ? AND source_person_id = ?)
					OR (target_person_id = ? AND source_person_id = ?)
				)
			),
			EXISTS (
				SELECT 1 FROM work_credit WHERE person_id = ? AND source = 'manual_override'
			)
	`, otherID, providerID, personID, otherID, otherID, personID, otherID).Scan(&otherIdentity, &undone, &manual); err != nil {
		return false, false, err
	}
	if otherIdentity || undone {
		return false, false, nil
	}
	return !manual, manual, nil
}

func personHasAdministratorMergedName(ctx context.Context, tx *sql.Tx, personID int64, name string) (bool, error) {
	var merged bool
	err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM person_alias
			WHERE person_id = ? AND alias = ?
				AND source IN ('merged_name', 'merged_primary_name', 'merged_alias')
		)
	`, personID, name).Scan(&merged)
	return merged, err
}

func isUnknownVoiceActorName(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), unknownVoiceActorName)
}

// upsertPerson resolves a credit without a provider id, which only a name
// identifies. One person of that name is that person. Of several, the name
// stands for a voice actor credited by name, never for a namesake identified
// by a provider id: it is the person among them who carries no voice actor
// id (the earliest when several do not), and when every one carries an id, a
// new person with the plain name, marked as made for an ambiguous name so no
// provider id or merge ever lands on it, which later credits of the name
// reuse. A name no person displays resolves through a confirmed alias only an
// undisputed one person holds, and is otherwise a new person.
func upsertPerson(ctx context.Context, tx *sql.Tx, name string) (int64, error) {
	name = strings.TrimSpace(name)
	namesakes, err := personsNamed(ctx, tx, name, 0)
	if err != nil {
		return 0, err
	}
	switch {
	case len(namesakes) == 1:
		return namesakes[0].id, nil
	case len(namesakes) > 1:
		for _, person := range namesakes {
			if !person.carriesAnyID {
				return person.id, nil
			}
		}
		return insertPerson(ctx, tx, name, true)
	}
	if id, found, err := personForConfirmedAlias(ctx, tx, name); err != nil || found {
		return id, err
	}
	return insertPerson(ctx, tx, name, false)
}

// insertPerson creates a person displayed under name, with that name as its
// primary alias. ambiguous marks a person made for a name several identified
// people hold.
func insertPerson(ctx context.Context, tx *sql.Tx, name string, ambiguous bool) (int64, error) {
	result, err := tx.ExecContext(ctx, `INSERT INTO person (display_name, sort_name, ambiguous_name) VALUES (?, ?, ?)`, name, strings.ToLower(name), ambiguous)
	if err != nil {
		return 0, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person_alias (person_id, alias, source)
		VALUES (?, ?, 'primary_name')
		ON CONFLICT(person_id, alias) DO NOTHING
	`, id, name); err != nil {
		return 0, err
	}
	return id, nil
}

// personForConfirmedAlias resolves a credited name that is no longer any
// person's display name but is still a confirmed alias, such as the former
// name of a merged or renamed voice actor. Without it, the next metadata
// projection would recreate the merged-away person and split the credits
// again. An exact display name always wins, and an alias several people hold
// is ambiguous, so both fall through to a new person.
func personForConfirmedAlias(ctx context.Context, tx *sql.Tx, name string) (int64, bool, error) {
	if name == "" || isUnknownVoiceActorName(name) {
		return 0, false, nil
	}
	var exact bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM person WHERE display_name = ?)", name).Scan(&exact); err != nil || exact {
		return 0, false, err
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT DISTINCT person_id FROM person_alias
		WHERE LOWER(alias) = LOWER(?)
		LIMIT 2
	`, name)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = rows.Close() }()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return 0, false, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return 0, false, err
	}
	if len(ids) != 1 {
		return 0, false, nil
	}
	return ids[0], true, nil
}

func (s *Server) loadPersonName(ctx context.Context, personID int64) (string, error) {
	var name string
	err := s.db.QueryRowContext(ctx, "SELECT display_name FROM person WHERE id = ?", personID).Scan(&name)
	return name, err
}

func (s *Server) loadVoiceAliases(ctx context.Context, personID int64) ([]voiceAlias, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, alias, source, created_at
		FROM person_alias
		WHERE person_id = ?
		ORDER BY CASE WHEN source = 'primary_name' THEN 0 ELSE 1 END, alias ASC
	`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	aliases := []voiceAlias{}
	for rows.Next() {
		var item voiceAlias
		if err := rows.Scan(&item.ID, &item.Alias, &item.Source, &item.CreatedAt); err != nil {
			return nil, err
		}
		aliases = append(aliases, item)
	}
	return aliases, rows.Err()
}

func (s *Server) loadVoiceAliasCandidates(ctx context.Context, personID int64, query string) ([]voiceAliasCandidate, error) {
	pattern := "%" + strings.ToLower(query) + "%"
	args := []any{personID}
	filter := ""
	if query != "" {
		filter = `AND (
			LOWER(person.display_name) LIKE ?
			OR EXISTS (
				SELECT 1 FROM person_alias AS candidate_alias
				WHERE candidate_alias.person_id = person.id
					AND LOWER(candidate_alias.alias) LIKE ?
			)
		)`
		args = append(args, pattern, pattern)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			person.id,
			person.display_name,
			COUNT(DISTINCT credit.work_id) AS known_works,
			COUNT(DISTINCT CASE WHEN EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = credit.work_id AND location.location_type = 'local' AND location.availability = 'available'
			) THEN credit.work_id END) AS local_works,
			COUNT(DISTINCT CASE WHEN EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = credit.work_id AND location.location_type IN ('remote_stream', 'remote_download') AND location.availability = 'available'
			) THEN credit.work_id END) AS remote_works
		FROM person
		LEFT JOIN work_credit AS credit ON credit.person_id = person.id AND credit.role = 'voice_actor'
		WHERE person.id <> ?
		`+filter+`
		GROUP BY person.id, person.display_name
		ORDER BY
			CASE WHEN ? = '' THEN 0 ELSE 1 END,
			known_works DESC,
			person.display_name ASC
		LIMIT 30
	`, append(args, query)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := []voiceAliasCandidate{}
	personIDs := []int64{}
	for rows.Next() {
		var item voiceAliasCandidate
		if err := rows.Scan(&item.PersonID, &item.DisplayName, &item.KnownWorks, &item.LocalWorks, &item.RemoteWorks); err != nil {
			return nil, err
		}
		candidates = append(candidates, item)
		personIDs = append(personIDs, item.PersonID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	aliasesByPerson, err := s.loadVoiceAliasesBatch(ctx, personIDs)
	if err != nil {
		return nil, err
	}
	for index := range candidates {
		candidates[index].Aliases = aliasesByPerson[candidates[index].PersonID]
	}
	return candidates, nil
}

// loadVoiceAliasesBatch returns every requested person's aliases, using an
// empty slice for a person without any, in the same order as loadVoiceAliases.
func (s *Server) loadVoiceAliasesBatch(ctx context.Context, personIDs []int64) (map[int64][]voiceAlias, error) {
	result := make(map[int64][]voiceAlias, len(personIDs))
	placeholders := make([]string, 0, len(personIDs))
	args := make([]any, 0, len(personIDs))
	for _, personID := range personIDs {
		if _, ok := result[personID]; ok {
			continue
		}
		result[personID] = []voiceAlias{}
		placeholders = append(placeholders, "?")
		args = append(args, personID)
	}
	if len(args) == 0 {
		return result, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT person_id, id, alias, source, created_at
		FROM person_alias
		WHERE person_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY person_id, CASE WHEN source = 'primary_name' THEN 0 ELSE 1 END, alias ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var personID int64
		var item voiceAlias
		if err := rows.Scan(&personID, &item.ID, &item.Alias, &item.Source, &item.CreatedAt); err != nil {
			return nil, err
		}
		result[personID] = append(result[personID], item)
	}
	return result, rows.Err()
}

func (s *Server) loadVoiceMergeReviews(ctx context.Context, personID int64) ([]voiceMergeReview, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, target_person_id, source_person_id, target_name, source_name, status, created_at, COALESCE(undone_at, '')
		FROM person_merge_review
		WHERE target_person_id = ?
		ORDER BY created_at DESC, id DESC
		LIMIT 20
	`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []voiceMergeReview{}
	for rows.Next() {
		var item voiceMergeReview
		if err := rows.Scan(&item.ID, &item.TargetPersonID, &item.SourcePersonID, &item.TargetName, &item.SourceName, &item.Status, &item.CreatedAt, &item.UndoneAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
