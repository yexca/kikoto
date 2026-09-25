package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// sqlInListBatchSize bounds one generated IN list. SQLite rejects a statement
// with more than 32766 bound parameters; a batch well below that leaves room
// for the fixed arguments a query binds beside the list while a library-wide
// list still takes only a few statements.
const sqlInListBatchSize = 5000

func int64InQuery(template string, values []int64) (string, []any) {
	placeholders := make([]string, 0, len(values))
	args := make([]any, 0, len(values))
	for _, value := range values {
		placeholders = append(placeholders, "?")
		args = append(args, value)
	}
	return fmt.Sprintf(template, strings.Join(placeholders, ",")), args
}

// queryInt64Batches runs template, whose %s takes an IN list, once per batch
// of values and calls scan for each row. fixedArgs bind before the list. Each
// result row must belong to one listed value, so a batch never splits a row's
// aggregate.
func (s *Server) queryInt64Batches(ctx context.Context, template string, values []int64, fixedArgs []any, scan func(*sql.Rows) error) error {
	for start := 0; start < len(values); start += sqlInListBatchSize {
		query, listArgs := int64InQuery(template, values[start:min(start+sqlInListBatchSize, len(values))])
		args := append(append(make([]any, 0, len(fixedArgs)+len(listArgs)), fixedArgs...), listArgs...)
		if err := s.scanQueryRows(ctx, query, args, scan); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) scanQueryRows(ctx context.Context, query string, args []any, scan func(*sql.Rows) error) error {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}
