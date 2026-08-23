package main

import (
	"bytes"
	"fmt"
	"go/format"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

func main() {
	roots := os.Args[1:]
	if len(roots) == 0 {
		roots = []string{"."}
	}

	var files []string
	for _, root := range roots {
		rootFiles, err := goFiles(root)
		if err != nil {
			fmt.Fprintf(os.Stderr, "walk Go source in %s: %v\n", root, err)
			os.Exit(1)
		}
		files = append(files, rootFiles...)
	}
	sort.Strings(files)

	failed := false
	for _, path := range files {
		source, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: read source: %v\n", path, err)
			failed = true
			continue
		}

		source = normalizeLineEndings(source)
		formatted, err := format.Source(source)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: format source: %v\n", path, err)
			failed = true
			continue
		}
		if !bytes.Equal(source, formatted) {
			fmt.Println(path)
			failed = true
		}
	}

	if failed {
		fmt.Fprintln(os.Stderr, "Go source is not gofmt-formatted.")
		os.Exit(1)
	}
}

func goFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if path != root && (entry.Name() == ".git" || entry.Name() == "bin") {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) == ".go" {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return files, nil
}

func normalizeLineEndings(source []byte) []byte {
	source = bytes.ReplaceAll(source, []byte("\r\n"), []byte("\n"))
	return bytes.ReplaceAll(source, []byte("\r"), []byte("\n"))
}
