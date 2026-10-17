package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"sort"
	"strings"
)

// Bundle membership relates DLsite codes; see ADR-0004. A bundle's detail
// lists the members declared for any code of its family, and a member's detail
// lists the bundles declaring any code of its family.

const (
	// maxWorkBundleMembers bounds the members a user may give one bundle.
	maxWorkBundleMembers = 64
	// maxWorkBundleCandidateWorks bounds the circle works read for series
	// suggestions.
	maxWorkBundleCandidateWorks = 500
	maxWorkBundleCandidates     = 32
)

// bundleTitleMarkers are title words that mark an official bundle. They only
// decide whether the editor offers series suggestions.
var bundleTitleMarkers = []string{
	"パック", "セット", "総集編", "コンプリート", "まとめ", "詰め合わせ", "合集", "合輯", "套装", "套裝", "합본", "세트", "pack", "bundle", "complete", "collection", "set",
}

type workBundleMember struct {
	Code   string `json:"code"`
	Origin string `json:"origin"`
	URL    string `json:"url"`
	// Work is set while a work in the library carries the code.
	Work *workLinkedWork `json:"work,omitempty"`
}

type workBundleRef struct {
	Code string          `json:"code"`
	URL  string          `json:"url"`
	Work *workLinkedWork `json:"work,omitempty"`
}

type workBundleCandidate struct {
	Code string          `json:"code"`
	URL  string          `json:"url"`
	Work *workLinkedWork `json:"work,omitempty"`
}

type workBundleCandidatesResponse struct {
	// LooksLikeBundle reports a title that names a bundle, or a bundle that
	// already has members.
	LooksLikeBundle bool                  `json:"looksLikeBundle"`
	SeriesID        string                `json:"seriesId"`
	Candidates      []workBundleCandidate `json:"candidates"`
}

type workBundleMembersResponse struct {
	BundleMembers []workBundleMember `json:"bundleMembers"`
}

// workFamilyCodesSQL selects, as one `code` column, the upper-case codes of the
// work bound to the first three arguments' work id: its own code, its
// family's editions, and the edition codes its family declares.
const workFamilyCodesSQL = `
	SELECT UPPER(primary_code) AS code FROM work WHERE id = ?
	UNION
	SELECT UPPER(sibling.primary_code)
	FROM work_edition AS edition
	JOIN work_edition AS sibling ON sibling.logical_work_id = edition.logical_work_id
	WHERE edition.work_id = ?
	UNION
	SELECT UPPER(alias.primary_code)
	FROM work_edition AS edition
	JOIN work_code_alias AS alias ON alias.logical_work_id = edition.logical_work_id
	WHERE edition.work_id = ?`

func (s *Server) workFamilyCodes(ctx context.Context, workID int64) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, workFamilyCodesSQL, workID, workID, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	codes := map[string]bool{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		codes[code] = true
	}
	return codes, rows.Err()
}

// loadWorkBundleMembers lists the linked members of every bundle code of the
// work's family, each code once, in the bundle's order.
func (s *Server) loadWorkBundleMembers(ctx context.Context, workID int64) ([]workBundleMember, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH family_code(code) AS (`+workFamilyCodesSQL+`)
		SELECT member.member_code, member.origin
		FROM work_bundle_member AS member
		WHERE member.status = 'linked'
			AND member.bundle_code IN (SELECT code FROM family_code)
			AND member.member_code NOT IN (SELECT code FROM family_code)
		ORDER BY member.position, member.member_code
	`, workID, workID, workID)
	if err != nil {
		return nil, err
	}
	members := []workBundleMember{}
	seen := map[string]bool{}
	for rows.Next() {
		var member workBundleMember
		if err := rows.Scan(&member.Code, &member.Origin); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if seen[member.Code] {
			continue
		}
		seen[member.Code] = true
		members = append(members, member)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range members {
		members[index].URL = s.dlsiteURL(members[index].Code)
		if members[index].Work, err = s.libraryWorkForCode(ctx, members[index].Code); err != nil {
			return nil, err
		}
	}
	return members, nil
}

// loadWorkIncludedInBundles lists the bundles outside the work's family that
// name any code of the family as a linked member.
func (s *Server) loadWorkIncludedInBundles(ctx context.Context, workID int64) ([]workBundleRef, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH family_code(code) AS (`+workFamilyCodesSQL+`)
		SELECT DISTINCT member.bundle_code
		FROM work_bundle_member AS member
		WHERE member.status = 'linked'
			AND member.member_code IN (SELECT code FROM family_code)
			AND member.bundle_code NOT IN (SELECT code FROM family_code)
		ORDER BY member.bundle_code
	`, workID, workID, workID)
	if err != nil {
		return nil, err
	}
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			_ = rows.Close()
			return nil, err
		}
		codes = append(codes, code)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	bundles := []workBundleRef{}
	// Two codes of one bundle family name the same library work once.
	seenWork := map[int64]bool{}
	for _, code := range codes {
		work, err := s.libraryWorkForCode(ctx, code)
		if err != nil {
			return nil, err
		}
		if work != nil {
			if seenWork[work.ID] {
				continue
			}
			seenWork[work.ID] = true
		}
		bundles = append(bundles, workBundleRef{Code: code, URL: s.dlsiteURL(code), Work: work})
	}
	return bundles, nil
}

// demoBundleRelations keeps only the bundle relations Demo may show: those
// whose library work is itself eligible for Demo.
func (s *Server) demoBundleRelations(ctx context.Context, members []workBundleMember, bundles []workBundleRef) ([]workBundleMember, []workBundleRef, error) {
	eligible := func(work *workLinkedWork) (bool, error) {
		if work == nil {
			return false, nil
		}
		ok, err := s.demoWorkEligible(ctx, work.ID)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return ok, err
	}
	keptMembers := []workBundleMember{}
	for _, member := range members {
		ok, err := eligible(member.Work)
		if err != nil {
			return nil, nil, err
		}
		if ok {
			keptMembers = append(keptMembers, member)
		}
	}
	keptBundles := []workBundleRef{}
	for _, bundle := range bundles {
		ok, err := eligible(bundle.Work)
		if err != nil {
			return nil, nil, err
		}
		if ok {
			keptBundles = append(keptBundles, bundle)
		}
	}
	return keptMembers, keptBundles, nil
}

// bundleMemberRequest resolves the work and member code of a membership change.
// The bundle is the work's own code; a member cannot belong to its family.
func (s *Server) bundleMemberRequest(w http.ResponseWriter, r *http.Request) (int64, string, string, map[string]bool, bool) {
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return 0, "", "", nil, false
	}
	memberCode := normalizeDLsiteCode(r.PathValue("code"))
	if memberCode == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work code"})
		return 0, "", "", nil, false
	}
	var bundleCode string
	if err := s.db.QueryRowContext(r.Context(), "SELECT UPPER(primary_code) FROM work WHERE id = ?", workID).Scan(&bundleCode); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return 0, "", "", nil, false
		}
		writeError(w, err)
		return 0, "", "", nil, false
	}
	family, err := s.workFamilyCodes(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return 0, "", "", nil, false
	}
	if family[memberCode] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a bundle cannot contain an edition of itself"})
		return 0, "", "", nil, false
	}
	return workID, bundleCode, memberCode, family, true
}

// addWorkBundleMember links a member to the work as its bundle. A member the
// user removed earlier is linked again.
func (s *Server) addWorkBundleMember(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, bundleCode, memberCode, _, ok := s.bundleMemberRequest(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	members, err := s.loadWorkBundleMembers(ctx, workID)
	if err != nil {
		writeError(w, err)
		return
	}
	known := false
	for _, member := range members {
		known = known || member.Code == memberCode
	}
	if !known && len(members) >= maxWorkBundleMembers {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a bundle has too many members"})
		return
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO work_bundle_member (bundle_code, member_code, position, status, origin, updated_by_user_id)
		VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM work_bundle_member WHERE bundle_code = ?), 0), 'linked', 'user', ?)
		ON CONFLICT(bundle_code, member_code) DO UPDATE SET
			status = 'linked',
			origin = 'user',
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = CURRENT_TIMESTAMP
	`, bundleCode, memberCode, bundleCode, nullableUserID(user.ID)); err != nil {
		writeError(w, err)
		return
	}
	s.writeWorkBundleMembers(w, r, workID)
}

// removeWorkBundleMember removes a member from every bundle code of the
// work's family. A detected member stays dismissed so detection does not add
// it again; a member a user added is forgotten.
func (s *Server) removeWorkBundleMember(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, _, memberCode, family, ok := s.bundleMemberRequest(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	for bundleCode := range family {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM work_bundle_member
			WHERE bundle_code = ? AND member_code = ? AND origin = 'user'
		`, bundleCode, memberCode); err != nil {
			writeError(w, err)
			return
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE work_bundle_member
			SET status = 'dismissed', origin = 'user', updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
			WHERE bundle_code = ? AND member_code = ? AND origin = 'detected'
		`, nullableUserID(user.ID), bundleCode, memberCode); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	s.writeWorkBundleMembers(w, r, workID)
}

func (s *Server) writeWorkBundleMembers(w http.ResponseWriter, r *http.Request, workID int64) {
	members, err := s.loadWorkBundleMembers(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workBundleMembersResponse{BundleMembers: members})
}

// listWorkBundleCandidates suggests members for a bundle from its DLsite
// series: the series' catalog codes and the library works of the bundle's
// circles in the same series. Members, removed members, and the bundle's own
// family are left out.
func (s *Server) listWorkBundleCandidates(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	ctx := r.Context()
	var title string
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(title, '') FROM work WHERE id = ?", workID).Scan(&title); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	family, err := s.workFamilyCodes(ctx, workID)
	if err != nil {
		writeError(w, err)
		return
	}
	excluded, hasMembers, err := s.bundleDecidedCodes(ctx, family)
	if err != nil {
		writeError(w, err)
		return
	}
	for code := range family {
		excluded[code] = true
	}
	seriesID := parseDLsiteSnapshot(s.latestDLsiteSnapshotJSON(ctx, workID)).SeriesID
	response := workBundleCandidatesResponse{
		LooksLikeBundle: hasMembers || titleNamesBundle(title),
		SeriesID:        seriesID,
		Candidates:      []workBundleCandidate{},
	}
	if seriesID != "" {
		codes, err := s.bundleSeriesCodes(ctx, workID, seriesID)
		if err != nil {
			writeError(w, err)
			return
		}
		for _, code := range codes {
			if excluded[code] || len(response.Candidates) >= maxWorkBundleCandidates {
				continue
			}
			excluded[code] = true
			work, err := s.libraryWorkForCode(ctx, code)
			if err != nil {
				writeError(w, err)
				return
			}
			if work != nil && family[strings.ToUpper(work.Code)] {
				continue
			}
			response.Candidates = append(response.Candidates, workBundleCandidate{Code: code, URL: s.dlsiteURL(code), Work: work})
		}
	}
	writeJSON(w, http.StatusOK, response)
}

// bundleDecidedCodes returns the member codes any bundle code of the family
// has a row for, and whether one of them is linked.
func (s *Server) bundleDecidedCodes(ctx context.Context, family map[string]bool) (map[string]bool, bool, error) {
	decided := map[string]bool{}
	linked := false
	for bundleCode := range family {
		rows, err := s.db.QueryContext(ctx, "SELECT member_code, status FROM work_bundle_member WHERE bundle_code = ?", bundleCode)
		if err != nil {
			return nil, false, err
		}
		for rows.Next() {
			var code, status string
			if err := rows.Scan(&code, &status); err != nil {
				_ = rows.Close()
				return nil, false, err
			}
			decided[code] = true
			linked = linked || status == "linked"
		}
		if err := rows.Close(); err != nil {
			return nil, false, err
		}
		if err := rows.Err(); err != nil {
			return nil, false, err
		}
	}
	return decided, linked, nil
}

// bundleSeriesCodes lists the codes of a DLsite series: the series' catalog
// entries in their catalog order, then library works of the work's circles
// whose stored DLsite metadata names the series, by code.
func (s *Server) bundleSeriesCodes(ctx context.Context, workID int64, seriesID string) ([]string, error) {
	codes := []string{}
	seen := map[string]bool{}
	add := func(code string) {
		code = normalizeDLsiteCode(code)
		if code != "" && !seen[code] {
			seen[code] = true
			codes = append(codes, code)
		}
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT series_work.primary_code
		FROM party_series AS series
		JOIN party_series_work AS series_work ON series_work.series_id = series.id
		WHERE UPPER(series.title_id) = ?
		ORDER BY series_work.position, series_work.primary_code
	`, seriesID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			_ = rows.Close()
			return nil, err
		}
		add(code)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.db.QueryContext(ctx, `
		SELECT DISTINCT circle_work.work_id, UPPER(work.primary_code)
		FROM work_party AS own
		JOIN work_party AS circle_work ON circle_work.party_id = own.party_id AND circle_work.role = own.role
		JOIN work ON work.id = circle_work.work_id
		WHERE own.work_id = ? AND own.role = 'circle' AND circle_work.work_id <> ?
		ORDER BY UPPER(work.primary_code)
		LIMIT ?
	`, workID, workID, maxWorkBundleCandidateWorks)
	if err != nil {
		return nil, err
	}
	type circleWork struct {
		id   int64
		code string
	}
	circleWorks := []circleWork{}
	for rows.Next() {
		var item circleWork
		if err := rows.Scan(&item.id, &item.code); err != nil {
			_ = rows.Close()
			return nil, err
		}
		circleWorks = append(circleWorks, item)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	library := []string{}
	for _, item := range circleWorks {
		if parseDLsiteSnapshot(s.latestDLsiteSnapshotJSON(ctx, item.id)).SeriesID == seriesID {
			library = append(library, item.code)
		}
	}
	sort.Strings(library)
	for _, code := range library {
		add(code)
	}
	return codes, nil
}

// latestDLsiteSnapshotJSON returns the work's newest stored DLsite snapshot,
// or an empty string.
func (s *Server) latestDLsiteSnapshotJSON(ctx context.Context, workID int64) string {
	var raw string
	if err := s.db.QueryRowContext(ctx, `
		SELECT snapshot.snapshot_json
		FROM metadata_snapshot AS snapshot
		JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
		WHERE snapshot.work_id = ? AND provider.code = 'dlsite'
		ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
		LIMIT 1
	`, workID).Scan(&raw); err != nil {
		return ""
	}
	return raw
}

// titleNamesBundle reports whether a title carries a bundle marker. Latin
// markers must stand as a word, so "settings" or "complete-ly" do not count.
func titleNamesBundle(title string) bool {
	lower := strings.ToLower(title)
	for _, marker := range bundleTitleMarkers {
		index := strings.Index(lower, marker)
		if index < 0 {
			continue
		}
		if marker[0] >= 'a' && marker[0] <= 'z' {
			before := index == 0 || !isASCIILetter(lower[index-1])
			end := index + len(marker)
			after := end == len(lower) || !isASCIILetter(lower[end])
			if !before || !after {
				continue
			}
		}
		return true
	}
	return false
}

func isASCIILetter(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
}
