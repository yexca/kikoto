package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

// DLsite reports genre names in the requested locale whether or not a work
// has a translated edition, so one request for any work that carries a genre
// teaches that genre's name. Genre name learning therefore spends requests per
// missing genre, not per work: for each preferred non-Japanese language it asks
// for the known work that covers the most unnamed genres, learns only the
// names in the response, and repeats until every genre is named or exhausted.
// It never creates works, editions, snapshots or relations and never reads a
// response's title or introduction.

const (
	// A genre that two answered lookups did not name is not requested again.
	maxGenreNameAttempts = 2
	maxGenreNameFailures = 50
)

// GenreNameLearningResult is the protected run summary of one learning pass.
type GenreNameLearningResult struct {
	Languages    []string `json:"languages"`
	Requests     int      `json:"requests"`
	LearnedNames int      `json:"learnedNames"`
	Exhausted    int      `json:"exhausted"`
	Failed       int      `json:"failed"`
	Failures     []string `json:"failures"`
	Remaining    int      `json:"remaining"`
}

type genreNameCandidate struct {
	workID int64
	code   string
}

// GenreNameLearningLanguages returns the preferred languages that can hold
// their own genre names. Japanese names come with every response.
func GenreNameLearningLanguages(priorities []string) []string {
	result := []string{}
	for _, language := range dlsite.NormalizeMetadataPriority(priorities) {
		if language == dlsite.OriginMetadataLanguage || language == "ja-jp" || dlsite.LocaleForMetadataLanguage(language) == "" {
			continue
		}
		result = append(result, language)
	}
	return result
}

// missingGenreNameSQL selects genres of genre.work_id that lack a name in the
// bound language and are not exhausted. The language is bound twice.
const missingGenreNameSQL = `NOT EXISTS (SELECT 1 FROM dlsite_genre_name AS name
		WHERE name.genre_id = genre.genre_id AND name.language = ? AND TRIM(name.name) <> '')
	AND NOT EXISTS (SELECT 1 FROM dlsite_genre_name_gap AS gap
		WHERE gap.genre_id = genre.genre_id AND gap.language = ? AND gap.exhausted = 1)`

// requestableGenreWorkSQL holds for a work never requested in the bound
// language that DLsite has not reported as not found.
func requestableGenreWorkSQL(alias string) string {
	return `NOT EXISTS (SELECT 1 FROM dlsite_genre_name_request AS request
			WHERE request.work_id = ` + alias + `.work_id AND request.language = ?)
		AND NOT EXISTS (SELECT 1 FROM work_metadata_provider_state AS provider_state
			JOIN metadata_provider AS provider ON provider.id = provider_state.provider_id
			WHERE provider_state.work_id = ` + alias + `.work_id AND provider.code = 'dlsite' AND provider_state.status = 'not_found')`
}

// PendingGenreNames counts unnamed, unexhausted genre and language pairs that
// still have a requestable work.
func PendingGenreNames(ctx context.Context, db *sql.DB, languages []string) (int, error) {
	total := 0
	for _, language := range languages {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT genre.genre_id) FROM work_dlsite_genre AS genre
			WHERE `+missingGenreNameSQL+` AND `+requestableGenreWorkSQL("genre"), language, language, language).Scan(&count); err != nil {
			return 0, err
		}
		total += count
	}
	return total, nil
}

// LearnGenreNames runs one resumable learning pass. Every answered request is
// committed with its learned names before the next request, so an interrupted
// pass continues where it stopped. A timeout, rate limit or network failure
// stops the pass with that error for the caller's retry policy; other request
// failures skip the work for this pass and are reported.
func (s *DLsiteSyncer) LearnGenreNames(ctx context.Context, languages []string, report func(GenreNameLearningResult)) (GenreNameLearningResult, error) {
	result := GenreNameLearningResult{Languages: languages, Failures: []string{}}
	if _, ok := s.client.(DLsiteClientWithLocale); !ok {
		return result, errors.New("DLsite client cannot request a locale")
	}
	for _, language := range languages {
		locale := dlsite.LocaleForMetadataLanguage(language)
		skipped := []int64{}
		for {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			candidate, found, err := nextGenreNameCandidate(ctx, s.db, language, skipped)
			if err != nil {
				return result, err
			}
			if !found {
				break
			}
			if !dlsiteWorkNoPattern.MatchString(candidate.code) {
				// A code DLsite cannot answer is recorded without a request.
				if err := s.recordGenreNameResponse(ctx, candidate, language, nil, &result); err != nil {
					return result, err
				}
				continue
			}
			result.Requests++
			product, fetchErr := s.fetchProductWithExactLocale(ctx, candidate.code, locale)
			switch {
			case fetchErr == nil && strings.EqualFold(dlsiteProductCode(product), candidate.code):
				err = s.recordGenreNameResponse(ctx, candidate, language, product.Genres, &result)
			case fetchErr == nil || errors.Is(fetchErr, dlsite.ErrNoProduct):
				// A missing or different product teaches nothing about the work.
				err = s.recordGenreNameResponse(ctx, candidate, language, nil, &result)
			case stopsGenreNameLearning(ctx, fetchErr):
				return result, fetchErr
			default:
				result.Failed++
				if len(result.Failures) < maxGenreNameFailures {
					result.Failures = append(result.Failures, fmt.Sprintf("%s %s: %s", candidate.code, language, fetchErr.Error()))
				}
				skipped = append(skipped, candidate.workID)
			}
			if err != nil {
				return result, err
			}
			if report != nil {
				report(result)
			}
		}
		exhausted, err := exhaustUnreachableGenreNames(ctx, s.db, language)
		if err != nil {
			return result, err
		}
		result.Exhausted += exhausted
	}
	remaining, err := PendingGenreNames(ctx, s.db, languages)
	result.Remaining = remaining
	return result, err
}

func stopsGenreNameLearning(ctx context.Context, err error) bool {
	var networkErr net.Error
	return ctx.Err() != nil || dlsite.IsTimeout(err) || dlsite.IsRetryableHTTPError(err) || errors.As(err, &networkErr)
}

// nextGenreNameCandidate picks the never-requested work whose genres cover the
// most unnamed genres in the language; a linked work is requested by the code
// its metadata comes from.
func nextGenreNameCandidate(ctx context.Context, db *sql.DB, language string, skipped []int64) (genreNameCandidate, bool, error) {
	skippedJSON, err := json.Marshal(skipped)
	if err != nil {
		return genreNameCandidate{}, false, err
	}
	var candidate genreNameCandidate
	var covered int
	err = db.QueryRowContext(ctx, `SELECT genre.work_id,
			COALESCE((SELECT link.source_code FROM work_metadata_link AS link
				JOIN metadata_provider AS provider ON provider.id = link.provider_id
				WHERE link.work_id = genre.work_id AND provider.code = 'dlsite'), work.primary_code),
			COUNT(*) AS covered
		FROM work_dlsite_genre AS genre
		JOIN work ON work.id = genre.work_id
		WHERE `+missingGenreNameSQL+` AND `+requestableGenreWorkSQL("genre")+`
			AND genre.work_id NOT IN (SELECT value FROM json_each(?))
		GROUP BY genre.work_id
		ORDER BY covered DESC, genre.work_id ASC
		LIMIT 1`, language, language, language, string(skippedJSON)).Scan(&candidate.workID, &candidate.code, &covered)
	if errors.Is(err, sql.ErrNoRows) {
		return genreNameCandidate{}, false, nil
	}
	if err != nil {
		return genreNameCandidate{}, false, err
	}
	candidate.code = strings.ToUpper(strings.TrimSpace(candidate.code))
	return candidate, true, nil
}

// recordGenreNameResponse learns the names of the response's genres that the
// library already knows, records the request, and counts an attempt for each
// of the work's unnamed genres the response did not name. Changed concepts get
// their display names refreshed in the same transaction; search documents are
// invalidated by the dictionary triggers.
func (s *DLsiteSyncer) recordGenreNameResponse(ctx context.Context, candidate genreNameCandidate, language string, genres []dlsite.Genre, result *GenreNameLearningResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	missing, err := genreIDs(ctx, tx, `SELECT genre.genre_id FROM work_dlsite_genre AS genre
		WHERE genre.work_id = ? AND `+missingGenreNameSQL, candidate.workID, language, language)
	if err != nil {
		return err
	}
	for _, genre := range genres {
		if genre.ID <= 0 {
			continue
		}
		var known bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM work_dlsite_genre WHERE genre_id = ?)", int64(genre.ID)).Scan(&known); err != nil {
			return err
		}
		if !known {
			continue
		}
		if err := learnDLsiteGenreNamesTx(ctx, tx, genre, language); err != nil {
			return err
		}
		if _, err := metadatatags.EnsureGenreTx(ctx, tx, int64(genre.ID)); err != nil {
			return err
		}
	}
	learned := 0
	for _, genreID := range missing {
		var named bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM dlsite_genre_name
			WHERE genre_id = ? AND language = ? AND TRIM(name) <> '')`, genreID, language).Scan(&named); err != nil {
			return err
		}
		if named {
			learned++
			continue
		}
		var exhausted bool
		if err := tx.QueryRowContext(ctx, `INSERT INTO dlsite_genre_name_gap (genre_id, language, attempts, exhausted)
			VALUES (?, ?, 1, CASE WHEN 1 >= ? THEN 1 ELSE 0 END)
			ON CONFLICT(genre_id, language) DO UPDATE SET
				attempts = dlsite_genre_name_gap.attempts + 1,
				exhausted = CASE WHEN dlsite_genre_name_gap.attempts + 1 >= ? THEN 1 ELSE dlsite_genre_name_gap.exhausted END,
				updated_at = CURRENT_TIMESTAMP
			RETURNING exhausted`, genreID, language, maxGenreNameAttempts, maxGenreNameAttempts).Scan(&exhausted); err != nil {
			return err
		}
		if exhausted {
			result.Exhausted++
		}
	}
	outcome := "not_found"
	if genres != nil {
		outcome = "no_names"
		if learned > 0 {
			outcome = "learned"
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO dlsite_genre_name_request (work_id, language, outcome) VALUES (?, ?, ?)
		ON CONFLICT(work_id, language) DO UPDATE SET outcome = excluded.outcome, requested_at = CURRENT_TIMESTAMP`,
		candidate.workID, language, outcome); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	result.LearnedNames += learned
	return nil
}

// exhaustUnreachableGenreNames marks unnamed genres without a requestable work
// in the language, so they are not selected again.
func exhaustUnreachableGenreNames(ctx context.Context, db *sql.DB, language string) (int, error) {
	result, err := db.ExecContext(ctx, `INSERT INTO dlsite_genre_name_gap (genre_id, language, attempts, exhausted)
		SELECT DISTINCT genre.genre_id, ?, 0, 1 FROM work_dlsite_genre AS genre
		WHERE `+missingGenreNameSQL+`
			AND NOT EXISTS (SELECT 1 FROM work_dlsite_genre AS other
				WHERE other.genre_id = genre.genre_id AND `+requestableGenreWorkSQL("other")+`)
		ON CONFLICT(genre_id, language) DO UPDATE SET exhausted = 1, updated_at = CURRENT_TIMESTAMP
		WHERE dlsite_genre_name_gap.exhausted = 0`, language, language, language, language)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	return int(count), err
}

func genreIDs(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	return ids, rows.Close()
}
