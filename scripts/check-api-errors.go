// Command check-api-errors keeps the HTTP API's error responses in one shape:
// error, a stable code, and retryable, written through writeAPIError or
// writeAPIErrorDetails. In the non-test Go files of the given directories it
// rejects a writeJSON call that writes an error status, and a writeJSON call
// whose body is a map literal with an "error" key, whatever its status.
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// successStatuses are the net/http status names below 400. Any other
// http.Status name passed to writeJSON is an error status.
var successStatuses = map[string]bool{
	"StatusContinue": true, "StatusSwitchingProtocols": true, "StatusProcessing": true, "StatusEarlyHints": true,
	"StatusOK": true, "StatusCreated": true, "StatusAccepted": true, "StatusNonAuthoritativeInfo": true,
	"StatusNoContent": true, "StatusResetContent": true, "StatusPartialContent": true, "StatusMultiStatus": true,
	"StatusAlreadyReported": true, "StatusIMUsed": true, "StatusMultipleChoices": true, "StatusMovedPermanently": true,
	"StatusFound": true, "StatusSeeOther": true, "StatusNotModified": true, "StatusUseProxy": true,
	"StatusTemporaryRedirect": true, "StatusPermanentRedirect": true,
}

func main() {
	dirs := os.Args[1:]
	if len(dirs) == 0 {
		dirs = []string{"internal/httpapi"}
	}
	var findings []string
	for _, dir := range dirs {
		dirFindings, err := checkDir(dir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "check API errors in %s: %v\n", dir, err)
			os.Exit(1)
		}
		findings = append(findings, dirFindings...)
	}
	if len(findings) == 0 {
		return
	}
	sort.Strings(findings)
	for _, finding := range findings {
		fmt.Println(finding)
	}
	fmt.Fprintln(os.Stderr, "Write API errors with writeAPIError or writeAPIErrorDetails: error, a stable code, and retryable.")
	fmt.Fprintln(os.Stderr, "See docs/architecture/backend/http-responses.md.")
	os.Exit(1)
}

func checkDir(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	fset := token.NewFileSet()
	var findings []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || filepath.Ext(name) != ".go" || strings.HasSuffix(name, "_test.go") {
			continue
		}
		path := filepath.Join(dir, name)
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return nil, err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) != 3 {
				return true
			}
			if ident, ok := call.Fun.(*ast.Ident); !ok || ident.Name != "writeJSON" {
				return true
			}
			position := fset.Position(call.Pos())
			location := fmt.Sprintf("%s:%d", filepath.ToSlash(position.Filename), position.Line)
			if isErrorStatus(call.Args[1]) {
				findings = append(findings, location+": writeJSON writes an error status")
			} else if hasErrorKey(call.Args[2]) {
				findings = append(findings, location+`: writeJSON writes an {"error": ...} map`)
			}
			return true
		})
	}
	return findings, nil
}

func isErrorStatus(expr ast.Expr) bool {
	switch status := expr.(type) {
	case *ast.SelectorExpr:
		pkg, ok := status.X.(*ast.Ident)
		return ok && pkg.Name == "http" && strings.HasPrefix(status.Sel.Name, "Status") && !successStatuses[status.Sel.Name]
	case *ast.BasicLit:
		if status.Kind != token.INT {
			return false
		}
		value, err := strconv.Atoi(status.Value)
		return err == nil && value >= 400
	}
	return false
}

func hasErrorKey(expr ast.Expr) bool {
	literal, ok := expr.(*ast.CompositeLit)
	if !ok {
		return false
	}
	if _, ok := literal.Type.(*ast.MapType); !ok {
		return false
	}
	for _, element := range literal.Elts {
		pair, ok := element.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		key, ok := pair.Key.(*ast.BasicLit)
		if !ok || key.Kind != token.STRING {
			continue
		}
		if value, err := strconv.Unquote(key.Value); err == nil && value == "error" {
			return true
		}
	}
	return false
}
