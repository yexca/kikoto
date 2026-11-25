// check-go-dropped-errors rejects production Go code that throws away the
// error of a workflow state write, a database write, or a JSON decode by
// assigning it to the blank identifier, deferring it, or calling it as a
// statement. A dropped workflow state write leaves a job, a run, or a source
// in a state nobody hears about; a dropped decode runs on zero values instead
// of the stored or requested ones.
//
// Run it from the backend module: go run ../scripts/check-go-dropped-errors.go .
//
// A deliberately tolerant JSON read stays possible: it carries a comment
// saying why, and an entry in tolerated below names its file, its enclosing
// function, and how many such reads it holds. Workflow state writes and
// database writes have no allowlist: log them through
// internal/httpapi/workflow_write_failures.go or return the error.
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// stateWrites are the workflow and source state writes whose error is logged
// through the helpers in internal/httpapi/workflow_write_failures.go when the
// caller carries on, whatever their receiver.
var stateWrites = map[string]bool{
	"failClaimedWorkflowJob":             true,
	"failLeasedWorkflowJob":              true,
	"failWorkflowGraphJob":               true,
	"finishLocalMediaDelete":             true,
	"finishMediaCacheRun":                true,
	"markVoiceCatalogRefreshFailed":      true,
	"recordRemoteFetchManifestError":     true,
	"recordWorkflowRunEvent":             true,
	"restoreMediaCleanupFolders":         true,
	"updateAvailabilityWatchTargetError": true,
	"updateRankingPullCheckpoint":        true,
	"updateRemoteFetchCacheProgress":     true,
	"updateRemoteFetchPhaseNode":         true,
	"updateSourceHealth":                 true,
	"updateWorkflowJobCheckpoint":        true,
	"updateWorkflowJobProgress":          true,
}

// tolerated lists the deliberately tolerant JSON reads, keyed by
// "file|function", with the number of blank-assigned decodes the function
// holds. Each read carries a comment saying why it tolerates a value it cannot
// decode. Remove an entry when its read is fixed or moved.
var tolerated = map[string]int{
	// Display labels and best-effort reads; see the comment at each read.
	"internal/httpapi/local_media_index_workflow.go|enqueueLocalMediaIndex":      1,
	"internal/httpapi/remote_fetch_files.go|remoteFetchFiles":                    1,
	"internal/httpapi/source_presence_check_settings.go|loadSourcePresenceCheck": 1,
	"internal/httpapi/voice_catalog_read.go|decodeVoiceCatalogStrings":           1,
	"internal/httpapi/voice_read_model.go|loadVoiceCatalogSyncProjections":       1,
	"internal/httpapi/workflow_helpers.go|mergeJSONObjects":                      1,
	"internal/httpapi/work_metadata_preview.go|previewValuesFromDLsiteProduct":   1,
}

type finding struct {
	path    string
	line    int
	call    string
	advice  string
	keyFunc string
}

func main() {
	roots := os.Args[1:]
	if len(roots) == 0 {
		roots = []string{"."}
	}
	var findings []finding
	for _, root := range roots {
		rootFindings, err := checkRoot(root)
		if err != nil {
			fmt.Fprintf(os.Stderr, "check Go source in %s: %v\n", root, err)
			os.Exit(1)
		}
		findings = append(findings, rootFindings...)
	}

	counts := map[string][]finding{}
	failed := false
	for _, f := range findings {
		if f.call == "json.Unmarshal" {
			key := f.path + "|" + f.keyFunc
			counts[key] = append(counts[key], f)
			continue
		}
		fmt.Printf("%s:%d: %s result dropped; %s\n", f.path, f.line, f.call, f.advice)
		failed = true
	}
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		found := counts[key]
		if len(found) <= tolerated[key] {
			continue
		}
		for _, f := range found {
			fmt.Printf("%s:%d: %s result dropped in %s; %s\n", f.path, f.line, f.call, f.keyFunc, f.advice)
		}
		failed = true
	}
	staleKeys := make([]string, 0, len(tolerated))
	for key := range tolerated {
		staleKeys = append(staleKeys, key)
	}
	sort.Strings(staleKeys)
	for _, key := range staleKeys {
		if found := len(counts[key]); found < tolerated[key] {
			fmt.Printf("%s: tolerates %d blank-assigned json.Unmarshal but holds %d; lower or remove its entry in scripts/check-go-dropped-errors.go\n", strings.Replace(key, "|", " in ", 1), tolerated[key], found)
			failed = true
		}
	}
	if failed {
		fmt.Fprintln(os.Stderr, "Go source drops errors it must handle or log.")
		os.Exit(1)
	}
}

func checkRoot(root string) ([]finding, error) {
	var findings []finding
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			name := entry.Name()
			if path != root && (name == ".git" || name == "bin" || name == "testdata" || name == "vendor") {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		fileFindings, err := checkFile(path, filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		findings = append(findings, fileFindings...)
		return nil
	})
	return findings, err
}

func checkFile(path string, rel string) ([]finding, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	var findings []finding
	for _, decl := range file.Decls {
		function, ok := decl.(*ast.FuncDecl)
		if !ok || function.Body == nil {
			continue
		}
		ast.Inspect(function.Body, func(node ast.Node) bool {
			var call *ast.CallExpr
			switch statement := node.(type) {
			case *ast.AssignStmt:
				if !allBlank(statement.Lhs) || len(statement.Rhs) != 1 {
					return true
				}
				call, _ = statement.Rhs[0].(*ast.CallExpr)
			case *ast.ExprStmt:
				call, _ = statement.X.(*ast.CallExpr)
			case *ast.DeferStmt:
				call = statement.Call
			case *ast.GoStmt:
				call = statement.Call
			}
			if call == nil {
				return true
			}
			if name, advice := checkedCall(call); name != "" {
				findings = append(findings, finding{
					path: rel, line: fset.Position(call.Pos()).Line, call: name, advice: advice, keyFunc: function.Name.Name,
				})
			}
			return true
		})
	}
	return findings, nil
}

func allBlank(exprs []ast.Expr) bool {
	for _, expr := range exprs {
		ident, ok := expr.(*ast.Ident)
		if !ok || ident.Name != "_" {
			return false
		}
	}
	return len(exprs) > 0
}

// checkedCall names a call whose error must not be dropped, with what to do
// instead, or returns "" for any other call.
func checkedCall(call *ast.CallExpr) (string, string) {
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		if stateWrites[fun.Name] {
			return fun.Name, stateWriteAdvice
		}
	case *ast.SelectorExpr:
		name := fun.Sel.Name
		if pkg, ok := fun.X.(*ast.Ident); ok && pkg.Name == "json" && name == "Unmarshal" {
			return "json.Unmarshal", "handle the decode error; a deliberately tolerant read needs a comment and an entry in scripts/check-go-dropped-errors.go"
		}
		if inner, ok := fun.X.(*ast.CallExpr); ok && name == "Decode" {
			if newDecoder, ok := inner.Fun.(*ast.SelectorExpr); ok && newDecoder.Sel.Name == "NewDecoder" {
				if pkg, ok := newDecoder.X.(*ast.Ident); ok && pkg.Name == "json" {
					return "json.Decoder.Decode", "an optional request body uses decodeOptionalJSONBody, which answers 400 for a malformed body"
				}
			}
		}
		if stateWrites[name] {
			return name, stateWriteAdvice
		}
		if name == "Exec" || name == "ExecContext" {
			return name, "return the write error, or log it where the caller carries on"
		}
	}
	return "", ""
}

const stateWriteAdvice = "return the error, or log it with failJobOrLog, checkpointJobOrLog, setSourceHealthOrLog, recordRunEventOrLog, or logWorkflowWriteError (internal/httpapi/workflow_write_failures.go)"
