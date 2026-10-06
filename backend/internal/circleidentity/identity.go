// Package circleidentity owns authored circle names, confirmed aliases, and
// reviewable duplicate merges. It never discovers or materializes works.
package circleidentity

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var ErrInvalid = errors.New("invalid circle identity change")
var ErrConflict = errors.New("circle merge changed since it was recorded")

type Alias struct {
	ID     int64  `json:"id"`
	Alias  string `json:"alias"`
	Source string `json:"source"`
}
type Circle struct {
	ID           int64    `json:"id"`
	DisplayName  string   `json:"displayName"`
	ManualName   string   `json:"manualName"`
	ProviderName string   `json:"providerName"`
	Aliases      []Alias  `json:"aliases"`
	ExternalIDs  []string `json:"externalIds"`
	// Code is the primary DLsite maker id (RGxxxxx), the key the Metadata
	// circle list is organized by. Circles known only from a remote source
	// have none.
	Code      string `json:"code"`
	WorkCount int    `json:"workCount"`
}

// CodeSQL selects the primary DLsite maker id for the party row named by
// partyRef, a trusted SQL alias.
func CodeSQL(partyRef string) string {
	return `(SELECT external.external_id FROM party_external_id AS external
 JOIN metadata_provider AS provider ON provider.id=external.provider_id AND provider.code='dlsite'
 WHERE external.party_id=` + partyRef + ` AND external.id_type='maker_id'
 ORDER BY external.is_primary DESC,external.id LIMIT 1)`
}

type Review struct {
	ID         int64  `json:"id"`
	TargetID   int64  `json:"targetPartyId"`
	SourceID   int64  `json:"sourcePartyId"`
	TargetName string `json:"targetName"`
	SourceName string `json:"sourceName"`
	Status     string `json:"status"`
	CreatedAt  string `json:"createdAt"`
	UndoneAt   string `json:"undoneAt"`
}
type Querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func closeRows(rows *sql.Rows) error {
	err := rows.Err()
	other := rows.Close()
	if err != nil {
		return err
	}
	return other
}
func Load(ctx context.Context, q Querier, id int64) (Circle, error) {
	var c Circle
	err := q.QueryRowContext(ctx, "SELECT id,display_name,manual_name,provider_name,COALESCE("+CodeSQL("party.id")+",''),(SELECT COUNT(DISTINCT work_id) FROM work_party WHERE party_id=party.id) FROM party WHERE id=? AND party_type IN ('circle','brand','maker')", id).Scan(&c.ID, &c.DisplayName, &c.ManualName, &c.ProviderName, &c.Code, &c.WorkCount)
	if err != nil {
		return c, err
	}
	c.Aliases = []Alias{}
	c.ExternalIDs = []string{}
	rows, err := q.QueryContext(ctx, "SELECT id,alias,source FROM party_alias WHERE party_id=? ORDER BY LOWER(alias),id", id)
	if err != nil {
		return c, err
	}
	for rows.Next() {
		var a Alias
		if err := rows.Scan(&a.ID, &a.Alias, &a.Source); err != nil {
			_ = rows.Close()
			return c, err
		}
		c.Aliases = append(c.Aliases, a)
	}
	if err := closeRows(rows); err != nil {
		return c, err
	}
	rows, err = q.QueryContext(ctx, "SELECT external_id FROM party_external_id WHERE party_id=? ORDER BY is_primary DESC,id", id)
	if err != nil {
		return c, err
	}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			_ = rows.Close()
			return c, err
		}
		c.ExternalIDs = append(c.ExternalIDs, e)
	}
	return c, closeRows(rows)
}
func RenameTx(ctx context.Context, tx *sql.Tx, id int64, name string) error {
	name = strings.TrimSpace(name)
	if len(name) > 512 {
		return ErrInvalid
	}
	result, err := tx.ExecContext(ctx, "UPDATE party SET manual_name=?,display_name=CASE WHEN ?<>'' THEN ? ELSE provider_name END,sort_name=LOWER(CASE WHEN ?<>'' THEN ? ELSE provider_name END),updated_at=CURRENT_TIMESTAMP WHERE id=?", name, name, name, name, name, id)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return sql.ErrNoRows
	}
	return err
}
func AddAliasTx(ctx context.Context, tx *sql.Tx, id int64, alias string) error {
	alias = strings.TrimSpace(alias)
	if alias == "" || len(alias) > 512 {
		return ErrInvalid
	}
	if _, err := Load(ctx, tx, id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO party_alias(party_id,alias,source) VALUES (?,?,'manual') ON CONFLICT(party_id,alias) DO NOTHING", id, alias)
	return err
}
func Reviews(ctx context.Context, q Querier, id int64) ([]Review, error) {
	rows, err := q.QueryContext(ctx, "SELECT id,target_party_id,source_party_id,target_name,source_name,status,created_at,COALESCE(undone_at,'') FROM party_merge_review WHERE target_party_id=? ORDER BY id DESC LIMIT 100", id)
	if err != nil {
		return nil, err
	}
	result := []Review{}
	for rows.Next() {
		var r Review
		if err := rows.Scan(&r.ID, &r.TargetID, &r.SourceID, &r.TargetName, &r.SourceName, &r.Status, &r.CreatedAt, &r.UndoneAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		result = append(result, r)
	}
	return result, closeRows(rows)
}
