package httpapi

import (
	"context"
	"database/sql"
	"errors"

	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
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

func completeLLMTags(plan llmTranslationPlan, result llm.Text) llm.Text {
	if len(plan.TagIDs) == 0 {
		return result
	}
	fresh := map[int64]string{}
	for i, id := range plan.SendingTagIDs {
		if i < len(result.Tags) {
			fresh[id] = result.Tags[i]
		}
	}
	result.Tags = []string{}
	for _, id := range plan.TagIDs {
		name, ok := plan.CachedTags[id]
		if !ok {
			name = fresh[id]
		}
		result.Tags = append(result.Tags, name)
	}
	return result
}
func (s *Server) saveLLMTagCandidates(ctx context.Context, userID int64, language string, plan llmTranslationPlan, result llm.Text) error {
	if len(plan.TagIDs) == 0 {
		return nil
	}
	if len(plan.TagIDs) != len(result.Tags) {
		return errors.New("tag result scope changed")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for i, id := range plan.TagIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO metadata_tag_llm_candidate(tag_id,language,source_text,config_hash,policy_hash,user_id,name) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(tag_id,language,config_hash,policy_hash,user_id) DO UPDATE SET name=CASE WHEN source_text=excluded.source_text THEN name ELSE excluded.name END,source_text=excluded.source_text,updated_at=CURRENT_TIMESTAMP`, id, language, plan.Source.Tags[i], s.llmConfigHash(plan.Provider, plan.Model), llmValueHash(plan.Policy), userID, result.Tags[i]); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func applyLLMTagNames(ctx context.Context, tx *sql.Tx, p llmPreview, userID int64) error {
	ids, names, err := loadLLMTagCandidates(ctx, tx, p.WorkID, p.Target)
	if err != nil {
		return err
	}
	if len(ids) != len(p.TagIDs) || len(p.Result.Tags) != len(ids) {
		return errors.New("tag names changed; translate again")
	}
	for i, id := range ids {
		if id != p.TagIDs[i] {
			return errors.New("tag names changed; translate again")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO metadata_tag_llm_name(tag_id,language,name,source_text,provider_id,model,created_by_user_id) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(tag_id,language) DO UPDATE SET name=excluded.name,source_text=excluded.source_text,provider_id=excluded.provider_id,model=excluded.model,created_by_user_id=excluded.created_by_user_id,updated_at=CURRENT_TIMESTAMP`, id, p.Target, p.Result.Tags[i], names[i], p.Provider.ID, p.Payload.Model, userID); err != nil {
			return err
		}
	}
	return metadatatags.RefreshNamesTx(ctx, tx, metadatatags.StoredLanguages, ids...)
}
