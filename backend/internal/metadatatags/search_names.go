package metadatatags

import "context"

// SearchNames retains exact-name matching for completion after merged sources
// have been collapsed into their final target. These names are not authored
// target names and do not participate in display-name precedence.
func SearchNames(ctx context.Context, q Querier, targetID int64) ([]Name, error) {
	rows, err := q.QueryContext(ctx, `WITH members AS (
 SELECT source_tag_id FROM metadata_tag_resolution WHERE resolved_tag_id=?
 ) SELECT '',tag.display_name,'alias' FROM members JOIN tag ON tag.id=members.source_tag_id
 UNION SELECT name.language,name.name,'manual' FROM members JOIN metadata_tag_name AS name ON name.tag_id=members.source_tag_id
 UNION SELECT name.language,name.name,'dlsite' FROM members JOIN metadata_tag AS concept ON concept.tag_id=members.source_tag_id JOIN dlsite_genre_name AS name ON name.genre_id=concept.dlsite_genre_id
 UNION SELECT name.language,name.name,'provider' FROM members JOIN metadata_tag_provider_name AS name ON name.tag_id=members.source_tag_id
 ORDER BY 1,2,3`, targetID)
	if err != nil {
		return nil, err
	}
	result := []Name{}
	for rows.Next() {
		var name Name
		if err := rows.Scan(&name.Language, &name.Name, &name.Source); err != nil {
			_ = rows.Close()
			return nil, err
		}
		result = append(result, name)
	}
	return result, closeRows(rows)
}
