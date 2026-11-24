// Command check-httpapi-sql is a ratchet on the SQL that HTTP handlers run
// directly. It counts the statements the non-test files of
// backend/internal/httpapi run themselves and compares the count with the
// recorded baseline. The count may only fall, and the baseline follows it
// down, so space freed by an extraction cannot be spent on new handler SQL.
//
// Run it from backend/:
//
//	go run ../scripts/check-httpapi-sql.go          # check
//	go run ../scripts/check-httpapi-sql.go -lower   # record a lower count
//	go run ../scripts/check-httpapi-sql.go -files   # also list each file's count
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// sqlMethods are the database/sql methods that run a statement. A method
// without a Context counts only when it is given a statement, which leaves
// out calls such as url.URL.Query().
var sqlMethods = map[string]bool{
	"ExecContext": true, "QueryContext": true, "QueryRowContext": true, "PrepareContext": true,
	"Exec": true, "Query": true, "QueryRow": true, "Prepare": true,
}

// sqlutilHelpers run the statement they are given.
var sqlutilHelpers = map[string]bool{"InsertID": true, "SelectID": true}

type baseline struct {
	CallSites int `json:"callSites"`
}

func main() {
	dir := flag.String("dir", "internal/httpapi", "package directory to count")
	baselinePath := flag.String("baseline", "../scripts/httpapi-sql-baseline.json", "recorded baseline")
	lower := flag.Bool("lower", false, "record the current count when it is below the baseline")
	files := flag.Bool("files", false, "list each file's count")
	flag.Parse()

	counts, err := countCallSites(*dir)
	if err != nil {
		fail("count SQL call sites in %s: %v", *dir, err)
	}
	total := 0
	for _, count := range counts {
		total += count
	}
	if *files {
		printFiles(counts)
	}
	recorded, err := readBaseline(*baselinePath)
	if err != nil {
		fail("read baseline %s: %v", *baselinePath, err)
	}

	switch {
	case total > recorded.CallSites:
		fail("%s runs %d SQL statements directly, %d above the baseline of %d.\n"+
			"Put new queries and state transitions in a focused internal/ package and call it from the handler;\n"+
			"see backend/AGENTS.md#layering. Never raise the baseline.",
			*dir, total, total-recorded.CallSites, recorded.CallSites)
	case total < recorded.CallSites && *lower:
		if err := writeBaseline(*baselinePath, baseline{CallSites: total}); err != nil {
			fail("write baseline %s: %v", *baselinePath, err)
		}
		fmt.Printf("Lowered the %s SQL baseline from %d to %d.\n", *dir, recorded.CallSites, total)
	case total < recorded.CallSites:
		fail("%s runs %d SQL statements directly, below the baseline of %d.\n"+
			"Record the lower count with make backend-sql-ratchet-lower and commit the baseline.",
			*dir, total, recorded.CallSites)
	default:
		fmt.Printf("%s runs %d SQL statements directly, at the baseline.\n", *dir, total)
	}
}

// countCallSites counts, per non-test Go file in dir, the calls that run a SQL
// statement.
func countCallSites(dir string) (map[string]int, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no Go files")
	}
	counts := map[string]int{}
	files := token.NewFileSet()
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(files, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			if call, ok := node.(*ast.CallExpr); ok && runsStatement(call) {
				counts[filepath.ToSlash(path)]++
			}
			return true
		})
	}
	return counts, nil
}

func runsStatement(call *ast.CallExpr) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	name := selector.Sel.Name
	if pkg, ok := selector.X.(*ast.Ident); ok && pkg.Name == "sqlutil" {
		return sqlutilHelpers[name]
	}
	if !sqlMethods[name] {
		return false
	}
	return strings.HasSuffix(name, "Context") || len(call.Args) > 0
}

func printFiles(counts map[string]int) {
	paths := make([]string, 0, len(counts))
	for path := range counts {
		paths = append(paths, path)
	}
	sort.Slice(paths, func(i, j int) bool {
		if counts[paths[i]] != counts[paths[j]] {
			return counts[paths[i]] > counts[paths[j]]
		}
		return paths[i] < paths[j]
	})
	for _, path := range paths {
		fmt.Printf("%5d %s\n", counts[path], path)
	}
}

func readBaseline(path string) (baseline, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return baseline{}, err
	}
	var recorded baseline
	if err := json.Unmarshal(data, &recorded); err != nil {
		return baseline{}, err
	}
	if recorded.CallSites <= 0 {
		return baseline{}, fmt.Errorf("callSites must be a positive count")
	}
	return recorded, nil
}

func writeBaseline(path string, recorded baseline) error {
	data, err := json.MarshalIndent(recorded, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
