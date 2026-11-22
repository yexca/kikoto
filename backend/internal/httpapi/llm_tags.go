package httpapi

import (
	"context"
	"database/sql"
	"errors"
)

func loadLLMTagCandidates(ctx context.Context, q metadatatitlesTagQuerier, workID int64, language string) ([]int64, []string, error) {
	sourceName := `COALESCE((SELECT name FROM metadata_tag_name WHERE tag_id=tag.id ORDER BY (language='ja-jp') DESC,language LIMIT 1),(SELECT name FROM dlsite_genre_name WHERE genre_id=concept.dlsite_genre_id ORDER BY (language='ja-jp') DESC,language LIMIT 1),(SELECT name FROM metadata_tag_provider_name WHERE tag_id=tag.id ORDER BY (language='ja-jp') DESC,language LIMIT 1),(SELECT source_text FROM metadata_tag_llm_name WHERE tag_id=tag.id ORDER BY language LIMIT 1),tag.display_name)`
	rows, err := q.QueryContext(ctx, `SELECT tag.id,`+sourceName+` FROM work_tag link
 JOIN tag ON tag.id=link.tag_id JOIN metadata_tag concept ON concept.tag_id=tag.id
 WHERE link.work_id=? AND concept.hidden=0 AND concept.merged_into_tag_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM metadata_tag_name WHERE tag_id=tag.id AND language IN (?, ''))
 AND NOT EXISTS(SELECT 1 FROM dlsite_genre_name WHERE genre_id=concept.dlsite_genre_id AND language=?)
 AND NOT EXISTS(SELECT 1 FROM metadata_tag_provider_name WHERE tag_id=tag.id AND language=?)
 AND NOT EXISTS(SELECT 1 FROM metadata_tag_llm_name WHERE tag_id=tag.id AND language=? AND source_text=`+sourceName+`)
 ORDER BY tag.id LIMIT 257`, workID, language, language, language, language)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	ids, names := []int64{}, []string{}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, nil, err
		}
		if len(name) > 512 {
			return nil, nil, errors.New("tag translation exceeds the text limit")
		}
		ids = append(ids, id)
		names = append(names, name)
	}
	if len(ids) > 256 {
		return nil, nil, errors.New("at most 256 tag names can be translated")
	}
	return ids, names, rows.Err()
}

type metadatatitlesTagQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}
