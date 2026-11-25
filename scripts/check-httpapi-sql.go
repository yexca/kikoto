// Command check-httpapi-sql is a ratchet on the SQL that HTTP handlers run
// directly. It counts the statements the non-test files of
// backend/internal/httpapi run themselves and compares the count with the
// recorded baseline. The count may only fall, and the baseline follows it
// down, so space freed by an extraction cannot be spent on new handler SQL.
//
// A function of the package that hands one of its own string parameters to a
// statement, as execBestEffort does, is a statement helper: each call to it
// counts as a statement, and the call inside it that runs the parameter does
// not. Helpers are found from the code, not from a list, so a new wrapper
// cannot hide the statements passed through it.
//
// Run it from backend/:
//
//	go run ../scripts/check-httpapi-sql.go           # check
//	go run ../scripts/check-httpapi-sql.go -lower    # record a lower count
//	go run ../scripts/check-httpapi-sql.go -files    # also list each file's count
//	go run ../scripts/check-httpapi-sql.go -helpers  # also list the statement helpers
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
	listHelpers := flag.Bool("helpers", false, "list the statement helpers and their statement parameter")
	flag.Parse()

	counts, helpers, err := countStatements(*dir)
	if err != nil {
		fail("count SQL statements in %s: %v", *dir, err)
	}
	total := 0
	for _, count := range counts {
		total += count
	}
	if *files {
		printFiles(counts)
	}
	if *listHelpers {
		printHelpers(helpers)
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

// statementFunction is a named function or a closure bound to a name, with the
// position of each of its string parameters.
type statementFunction struct {
	name   string
	node   ast.Node
	body   *ast.BlockStmt
	params map[string]int
}

// countStatements counts, per non-test Go file in dir, the calls that run a
// SQL statement, and returns the statement helpers it found on the way, each
// with the position of its statement parameter.
func countStatements(dir string) (map[string]int, map[string]int, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		return nil, nil, err
	}
	fset := token.NewFileSet()
	parsed := map[string]*ast.File{}
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return nil, nil, err
		}
		parsed[filepath.ToSlash(path)] = file
	}
	if len(parsed) == 0 {
		return nil, nil, fmt.Errorf("no Go files")
	}

	var functions []statementFunction
	for _, file := range parsed {
		functions = append(functions, namedFunctions(file)...)
	}
	helpers, forwarding := findStatementHelpers(functions)

	counts := map[string]int{}
	for path, file := range parsed {
		if count := countFile(file, helpers, forwarding); count > 0 {
			counts[path] = count
		}
	}
	return counts, helpers, nil
}

// namedFunctions lists the file's functions and methods and the closures it
// binds to a name, as in exec := func(query string) { ... }.
func namedFunctions(file *ast.File) []statementFunction {
	var functions []statementFunction
	bind := func(name *ast.Ident, value ast.Expr) {
		if literal, ok := value.(*ast.FuncLit); ok && name.Name != "_" {
			functions = append(functions, statementFunction{name: name.Name, node: literal, body: literal.Body, params: stringParams(literal.Type)})
		}
	}
	ast.Inspect(file, func(node ast.Node) bool {
		switch node := node.(type) {
		case *ast.FuncDecl:
			if node.Body != nil {
				functions = append(functions, statementFunction{name: node.Name.Name, node: node, body: node.Body, params: stringParams(node.Type)})
			}
		case *ast.AssignStmt:
			if len(node.Lhs) == len(node.Rhs) {
				for i, lhs := range node.Lhs {
					if name, ok := lhs.(*ast.Ident); ok {
						bind(name, node.Rhs[i])
					}
				}
			}
		case *ast.ValueSpec:
			if len(node.Names) == len(node.Values) {
				for i, name := range node.Names {
					bind(name, node.Values[i])
				}
			}
		}
		return true
	})
	return functions
}

// stringParams maps each string parameter of a signature to its position.
func stringParams(signature *ast.FuncType) map[string]int {
	params := map[string]int{}
	position := 0
	for _, field := range signature.Params.List {
		names := len(field.Names)
		if names == 0 {
			names = 1
		}
		if kind, ok := field.Type.(*ast.Ident); ok && kind.Name == "string" {
			for i, name := range field.Names {
				params[name.Name] = position + i
			}
		}
		position += names
	}
	return params
}

// findStatementHelpers repeats until no function joins: a function is a
// helper once a statement it runs, or a helper it calls, is built from one of
// its string parameters. It returns each helper's statement position and, for
// each helper's node, the parameter that carries the statement.
func findStatementHelpers(functions []statementFunction) (map[string]int, map[ast.Node]string) {
	helpers := map[string]int{}
	forwarding := map[ast.Node]string{}
	for changed := true; changed; {
		changed = false
		for _, function := range functions {
			if _, known := forwarding[function.node]; known || len(function.params) == 0 {
				continue
			}
			ast.Inspect(function.body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				argument, _ := statementArgument(call, helpers)
				if argument == nil {
					return true
				}
				for name, position := range function.params {
					if mentions(argument, name) {
						helpers[function.name] = position
						forwarding[function.node] = name
						changed = true
						return false
					}
				}
				return true
			})
		}
	}
	return helpers, forwarding
}

// countFile counts the file's calls that run a statement, leaving out the
// call inside a helper that runs the statement its caller passed, which is
// counted at that caller.
func countFile(file *ast.File, helpers map[string]int, forwarding map[ast.Node]string) int {
	count := 0
	var walk func(root ast.Node, passed map[string]bool)
	walk = func(root ast.Node, passed map[string]bool) {
		ast.Inspect(root, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.FuncDecl, *ast.FuncLit:
				if node == root {
					return true
				}
				inner := passed
				if name, ok := forwarding[node]; ok {
					inner = map[string]bool{name: true}
					for outer := range passed {
						inner[outer] = true
					}
				}
				walk(node, inner)
				return false
			case *ast.CallExpr:
				if argument, _ := statementArgument(node, helpers); argument != nil && !mentionsAny(argument, passed) {
					count++
				}
			}
			return true
		})
	}
	walk(file, nil)
	return count
}

// statementArgument returns the argument that carries the statement a call
// runs, and whether the call goes through one of the package's own helpers,
// or nil when the call runs no statement.
func statementArgument(call *ast.CallExpr, helpers map[string]int) (ast.Expr, bool) {
	position, viaHelper := -1, false
	switch fun := call.Fun.(type) {
	case *ast.SelectorExpr:
		name := fun.Sel.Name
		if pkg, ok := fun.X.(*ast.Ident); ok && pkg.Name == "sqlutil" {
			if sqlutilHelpers[name] {
				position = 2
			}
		} else if sqlMethods[name] {
			position = 0
			if strings.HasSuffix(name, "Context") {
				position = 1
			}
		} else if helper, ok := helpers[name]; ok {
			position, viaHelper = helper, true
		}
	case *ast.Ident:
		if helper, ok := helpers[fun.Name]; ok {
			position, viaHelper = helper, true
		}
	}
	if position < 0 || position >= len(call.Args) {
		return nil, false
	}
	return call.Args[position], viaHelper
}

func mentions(expr ast.Expr, name string) bool {
	return mentionsAny(expr, map[string]bool{name: true})
}

func mentionsAny(expr ast.Expr, names map[string]bool) bool {
	if len(names) == 0 {
		return false
	}
	found := false
	ast.Inspect(expr, func(node ast.Node) bool {
		if ident, ok := node.(*ast.Ident); ok && names[ident.Name] {
			found = true
		}
		return !found
	})
	return found
}

func printHelpers(helpers map[string]int) {
	names := make([]string, 0, len(helpers))
	for name := range helpers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Printf("helper %s: statement is argument %d\n", name, helpers[name])
	}
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
