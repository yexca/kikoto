package httpapi

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/library"
)

// Translation coverage reports, for one target language, what each work family
// already has in that language: title and description from an edition, a
// manual title or an accepted LLM translation; shared tag names; display
// names of local files; and lyrics assigned to local tracks. It reads stored
// state only and never contacts a provider.

// translationCoverageFamily lists the works of the row's family: every edition
// of its logical work, or the work alone.
const translationCoverageFamily = `(SELECT sibling.work_id FROM work_edition AS self
	INNER JOIN work_edition AS sibling ON sibling.logical_work_id = self.logical_work_id
	WHERE self.work_id = work.id UNION SELECT work.id)`

// translationCoverageLocalItems are the family's media items with an
// available local file.
const translationCoverageLocalItems = `media_item AS item WHERE item.work_id IN ` + translationCoverageFamily + `
	AND EXISTS (SELECT 1 FROM media_file_location AS location WHERE location.media_item_id = item.id
		AND location.location_type = 'local' AND location.availability = 'available')`

var translationCoverageFilters = []string{"all", "any", "complete", "title", "description", "tags", "files", "lyrics"}

type translationCount struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

type translationCoverage struct {
	// OriginLanguage is the declared language of the family's original
	// edition, or empty when unknown.
	OriginLanguage string `json:"originLanguage"`
	// Title and Description name where the target language's text comes from:
	// origin, edition, manual (title only), llm, or missing.
	Title       string           `json:"title"`
	Description string           `json:"description"`
	Tags        translationCount `json:"tags"`
	Files       translationCount `json:"files"`
	Lyrics      translationCount `json:"lyrics"`
	// Running and Review count the requester's own translations into the
	// language that are queued or waiting for review.
	Running int `json:"running"`
	Review  int `json:"review"`
}

type translationCoverageWork struct {
	libraryWorkSummary
	Translation translationCoverage `json:"translation"`
}

// translationCoverageSQL holds the predicates of one target language.
type translationCoverageSQL struct {
	language string
	// editionLanguages are the stored edition language spellings that mean the
	// target language.
	editionLanguages []any
}

func newTranslationCoverageSQL(ctx context.Context, s *Server, language string) (translationCoverageSQL, error) {
	result := translationCoverageSQL{language: language}
	rows, err := s.db.QueryContext(ctx, "SELECT DISTINCT metadata_language FROM work_edition")
	if err != nil {
		return result, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return result, err
		}
		if dlsite.EditionMetadataLanguage(raw) == language {
			result.editionLanguages = append(result.editionLanguages, raw)
		}
	}
	if len(result.editionLanguages) == 0 {
		// No stored spelling means the language; an empty IN list is not valid SQL.
		result.editionLanguages = []any{"\x00"}
	}
	return result, rows.Err()
}

func (c translationCoverageSQL) editionList() string {
	return "(" + strings.TrimSuffix(strings.Repeat("?,", len(c.editionLanguages)), ",") + ")"
}

func (c translationCoverageSQL) origin() (string, []any) {
	return `EXISTS (SELECT 1 FROM work_edition AS edition INNER JOIN work_edition AS canonical
		ON canonical.logical_work_id = edition.logical_work_id AND canonical.is_canonical = 1
		WHERE edition.work_id = work.id AND canonical.metadata_language IN ` + c.editionList() + `)`, c.editionLanguages
}

func (c translationCoverageSQL) edition() (string, []any) {
	return `EXISTS (SELECT 1 FROM work_edition AS edition WHERE edition.work_id IN ` + translationCoverageFamily + `
		AND edition.metadata_language IN ` + c.editionList() + `)`, c.editionLanguages
}

func (c translationCoverageSQL) manualTitle() (string, []any) {
	return `EXISTS (SELECT 1 FROM work_manual_override AS override WHERE override.work_id IN ` + translationCoverageFamily + `
		AND override.field_name = 'title' AND override.language = ? AND override.value_json NOT IN ('null', '""'))`, []any{c.language}
}

func (c translationCoverageSQL) llm(field string) (string, []any) {
	return `EXISTS (SELECT 1 FROM work_llm_translation AS translation WHERE translation.work_id IN ` + translationCoverageFamily + `
		AND translation.field_name = ? AND translation.language = ? AND translation.status = 'accepted')`, []any{field, c.language}
}

// tagNamed matches a shared tag concept (`concept`) that has a name the
// language shows: its own or the all-language manual name, the DLsite
// dictionary name, a remote source's name, or a confirmed LLM name.
func (c translationCoverageSQL) tagNamed() (string, []any) {
	return `(EXISTS (SELECT 1 FROM metadata_tag_name AS name WHERE name.tag_id = concept.tag_id AND name.language IN (?, ''))
		OR EXISTS (SELECT 1 FROM dlsite_genre_name AS name WHERE name.genre_id = concept.dlsite_genre_id AND name.language = ?)
		OR EXISTS (SELECT 1 FROM metadata_tag_provider_name AS name WHERE name.tag_id = concept.tag_id AND name.language = ?)
		OR EXISTS (SELECT 1 FROM metadata_tag_llm_name AS name WHERE name.tag_id = concept.tag_id AND name.language = ?))`,
		[]any{c.language, c.language, c.language, c.language}
}

// tags counts the row work's active shared tags, or those of them without a
// name in the language.
func (c translationCoverageSQL) tags(unnamedOnly bool) (string, []any) {
	from, args := c.tagRows(unnamedOnly)
	return "(SELECT COUNT(DISTINCT link.tag_id) FROM " + from + ")", args
}

func (c translationCoverageSQL) tagRows(unnamedOnly bool) (string, []any) {
	query := `work_tag AS link
		INNER JOIN metadata_tag AS concept ON concept.tag_id = link.tag_id
		WHERE link.work_id = work.id AND concept.hidden = 0 AND concept.merged_into_tag_id IS NULL`
	if !unnamedOnly {
		return query, nil
	}
	named, args := c.tagNamed()
	return query + " AND NOT " + named, args
}

func (c translationCoverageSQL) files(unnamedOnly bool) (string, []any) {
	from, args := c.fileRows(unnamedOnly)
	return "(SELECT COUNT(*) FROM " + from + ")", args
}

func (c translationCoverageSQL) fileRows(unnamedOnly bool) (string, []any) {
	if !unnamedOnly {
		return translationCoverageLocalItems, nil
	}
	return translationCoverageLocalItems + ` AND NOT EXISTS (SELECT 1 FROM media_item_display_name AS name
		WHERE name.media_item_id = item.id AND name.language = ?)`, []any{c.language}
}

func (c translationCoverageSQL) lyrics(missingOnly bool) (string, []any) {
	from, args := c.trackRows(missingOnly)
	return "(SELECT COUNT(*) FROM " + from + ")", args
}

func (c translationCoverageSQL) trackRows(missingOnly bool) (string, []any) {
	query := translationCoverageLocalItems + " AND item.kind = 'audio'"
	if !missingOnly {
		return query, nil
	}
	return query + ` AND NOT EXISTS (SELECT 1 FROM media_lyrics_assignment AS assignment
		WHERE assignment.audio_media_item_id = item.id AND assignment.language = ?)`, []any{c.language}
}

// exists turns rows from a FROM clause into a predicate, which stops at the
// first row where a count would read them all.
func exists(from string, args []any) (string, []any) {
	return "EXISTS (SELECT 1 FROM " + from + ")", args
}

// missing is the predicate of a filter that lists works lacking the language
// somewhere; "all" lists every work.
func (c translationCoverageSQL) missing(filter string) (string, []any) {
	sql := &sqlBuilder{}
	switch filter {
	case "title":
		sql.not(c.edition()).and().not(c.manualTitle()).and().not(c.llm("title"))
	case "description":
		sql.not(c.edition()).and().not(c.llm("description"))
	case "tags":
		sql.add(exists(c.tagRows(true)))
	case "files":
		sql.not(c.origin()).and().add(exists(c.fileRows(true)))
	case "lyrics":
		sql.add(exists(c.trackRows(true)))
	case "any", "complete":
		for index, part := range []string{"title", "description", "tags", "files", "lyrics"} {
			if index > 0 {
				sql.text(" OR ")
			}
			sql.text("(").add(c.missing(part)).text(")")
		}
		if filter == "complete" {
			return "NOT (" + sql.query + ")", sql.args
		}
	default:
		return "", nil
	}
	return sql.query, sql.args
}

type sqlBuilder struct {
	query string
	args  []any
}

func (b *sqlBuilder) text(value string) *sqlBuilder {
	b.query += value
	return b
}

func (b *sqlBuilder) add(query string, args []any) *sqlBuilder {
	b.query += query
	b.args = append(b.args, args...)
	return b
}

func (b *sqlBuilder) not(query string, args []any) *sqlBuilder {
	return b.text("NOT ").add(query, args)
}

func (b *sqlBuilder) and() *sqlBuilder { return b.text(" AND ") }

func (s *Server) listTranslationCoverage(w http.ResponseWriter, r *http.Request) {
	actor, ok := userFromContext(r.Context())
	if !ok {
		writeAPIError(w, http.StatusUnauthorized, "login_required", "login required", false)
		return
	}
	if !s.cfg.IsDemo() && !userHasPermission(actor, "metadata:sync") && !userHasPermission(actor, "library:write") {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
		return
	}
	language := r.URL.Query().Get("language")
	filter := r.URL.Query().Get("missing")
	if filter == "" {
		filter = "any"
	}
	options := library.MaintenanceOptions{ListOptions: library.ListOptions{UserID: actor.ID, Page: 1, PageSize: 25,
		Query: strings.TrimSpace(r.URL.Query().Get("q")), DemoOnly: s.cfg.IsDemo()}, Reason: "translation"}
	for key, target := range map[string]*int{"page": &options.Page, "pageSize": &options.PageSize} {
		if value := r.URL.Query().Get(key); value != "" {
			number, err := strconv.Atoi(value)
			if err != nil || number < 1 || number > 1000000 || (key == "pageSize" && number != 25 && number != 50) {
				writeAPIError(w, http.StatusBadRequest, "invalid_page", "invalid page", false)
				return
			}
			*target = number
		}
	}
	if len(options.Query) > 256 || !slices.Contains(dlsite.SupportedMetadataLanguages, language) || !slices.Contains(translationCoverageFilters, filter) {
		writeAPIError(w, http.StatusBadRequest, "invalid_filter", "invalid translation coverage filter", false)
		return
	}
	coverage, err := newTranslationCoverageSQL(r.Context(), s, language)
	if err != nil {
		writeError(w, err)
		return
	}
	options.FilterWhere, options.FilterArgs = coverage.missing(filter)
	page, err := s.libraryStore.ListMaintenance(r.Context(), options)
	if err != nil {
		writeError(w, err)
		return
	}
	works, err := s.scanLibraryWorkRows(r.Context(), actor.ID, page.Works, true)
	if err != nil {
		writeError(w, err)
		return
	}
	states, err := s.loadTranslationCoverage(r.Context(), coverage, actor.ID, works)
	if err != nil {
		writeError(w, err)
		return
	}
	items := make([]translationCoverageWork, 0, len(works))
	for _, work := range works {
		items = append(items, translationCoverageWork{libraryWorkSummary: work, Translation: states[work.ID]})
	}
	writeJSON(w, http.StatusOK, struct {
		Language string                    `json:"language"`
		Works    []translationCoverageWork `json:"works"`
		Total    int                       `json:"total"`
		Page     int                       `json:"page"`
		PageSize int                       `json:"pageSize"`
	}{language, items, page.Total, page.Page, page.PageSize})
}

// loadTranslationCoverage reads the coverage of one page of works in a single
// query.
func (s *Server) loadTranslationCoverage(ctx context.Context, c translationCoverageSQL, userID int64, works []libraryWorkSummary) (map[int64]translationCoverage, error) {
	result := map[int64]translationCoverage{}
	if len(works) == 0 {
		return result, nil
	}
	sql := &sqlBuilder{}
	sql.text(`SELECT work.id, COALESCE((SELECT canonical.metadata_language FROM work_edition AS edition
		INNER JOIN work_edition AS canonical ON canonical.logical_work_id = edition.logical_work_id AND canonical.is_canonical = 1
		WHERE edition.work_id = work.id ORDER BY canonical.work_id LIMIT 1), ''), `)
	sql.add(c.edition()).text(", ").add(c.manualTitle()).text(", ").add(c.llm("title")).text(", ").add(c.llm("description")).text(", ")
	sql.add(c.tags(false)).text(", ").add(c.tags(true)).text(", ")
	sql.add(c.files(false)).text(", ").add(c.files(true)).text(", ")
	sql.add(c.lyrics(false)).text(", ").add(c.lyrics(true)).text(", ")
	sql.text(`(SELECT COUNT(*) FROM llm_translation_task AS task WHERE task.user_id = ? AND task.work_id IN ` + translationCoverageFamily + `
		AND task.state IN ('pending', 'requesting') AND json_extract(task.request_json, '$.targetLanguage') = ?), `)
	sql.args = append(sql.args, userID, c.language)
	sql.text(`(SELECT COUNT(*) FROM llm_translation_preview AS preview WHERE preview.user_id = ? AND preview.work_id IN ` + translationCoverageFamily + `
		AND preview.status = 'proposed' AND preview.expires_at > ? AND json_extract(preview.payload_json, '$.Target') = ?)`)
	sql.args = append(sql.args, userID, time.Now().Unix(), c.language)
	marks := make([]string, len(works))
	for index, work := range works {
		marks[index] = "?"
		sql.args = append(sql.args, work.ID)
	}
	sql.text(" FROM work WHERE work.id IN (" + strings.Join(marks, ",") + ")")
	rows, err := s.db.QueryContext(ctx, sql.query, sql.args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var originRaw string
		var edition, manualTitle, llmTitle, llmDescription bool
		var tags, unnamedTags, files, unnamedFiles, tracks, tracksWithout int
		var state translationCoverage
		if err := rows.Scan(&id, &originRaw, &edition, &manualTitle, &llmTitle, &llmDescription,
			&tags, &unnamedTags, &files, &unnamedFiles, &tracks, &tracksWithout, &state.Running, &state.Review); err != nil {
			return nil, err
		}
		state.OriginLanguage = dlsite.EditionMetadataLanguage(originRaw)
		origin := state.OriginLanguage == c.language
		state.Title = translationSource(origin, edition, manualTitle, llmTitle)
		state.Description = translationSource(origin, edition, false, llmDescription)
		state.Tags = translationCount{Done: tags - unnamedTags, Total: tags}
		state.Files = translationCount{Done: files - unnamedFiles, Total: files}
		if origin {
			// Real file names are already in the original language.
			state.Files.Done = files
		}
		state.Lyrics = translationCount{Done: tracks - tracksWithout, Total: tracks}
		result[id] = state
	}
	return result, rows.Err()
}

func translationSource(origin, edition, manual, llm bool) string {
	switch {
	case origin:
		return "origin"
	case edition:
		return "edition"
	case manual:
		return "manual"
	case llm:
		return "llm"
	default:
		return "missing"
	}
}
