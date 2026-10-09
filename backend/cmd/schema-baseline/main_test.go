package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func writeGeneratorFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, contents := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func listFixture(t *testing.T, dir string, subdir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, subdir))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func generatorFixture(t *testing.T) string {
	return writeGeneratorFixture(t, map[string]string{
		"001_create_probe.sql":    "CREATE TABLE probe (id INTEGER PRIMARY KEY);",
		"002_add_probe_value.sql": "ALTER TABLE probe ADD COLUMN value TEXT;",
		"baseline/001_v0.1.0.sql": "CREATE TABLE probe (id INTEGER PRIMARY KEY);",
		"compat/001_dev.sql":      "-- stale development baseline",
		"compat/README.md":        "Development baselines.",
		"VERSION":                 "v0.2.0\n",
	})
}

func TestGenerateWritesDevelopmentBaselineByDefault(t *testing.T) {
	dir := generatorFixture(t)
	if _, err := generate(options{migrationsDir: dir}); err != nil {
		t.Fatalf("generate() error = %v", err)
	}
	if got, want := strings.Join(listFixture(t, dir, "compat"), ","), "001_dev.sql,002_dev.sql,README.md"; got != want {
		t.Fatalf("compat files = %q, want %q", got, want)
	}
	if got, want := strings.Join(listFixture(t, dir, "baseline"), ","), "001_v0.1.0.sql"; got != want {
		t.Fatalf("baseline files = %q, want %q", got, want)
	}
}

func TestGenerateSkipsDevelopmentBaselineForReleasedSchema(t *testing.T) {
	dir := generatorFixture(t)
	if err := os.Remove(filepath.Join(dir, "002_add_probe_value.sql")); err != nil {
		t.Fatal(err)
	}
	if _, err := generate(options{migrationsDir: dir}); err != nil {
		t.Fatalf("generate() error = %v", err)
	}
	if got, want := strings.Join(listFixture(t, dir, "compat"), ","), "001_dev.sql,README.md"; got != want {
		t.Fatalf("compat files = %q, want %q", got, want)
	}
}

func TestGenerateReleaseWritesReleasedBaselineAndClearsCompat(t *testing.T) {
	for _, testCase := range []struct {
		name         string
		removeHead   bool
		wantBaseline string
	}{
		{name: "new schema", wantBaseline: "001_v0.1.0.sql,002_v0.2.0.sql"},
		{name: "unchanged schema", removeHead: true, wantBaseline: "001_v0.1.0.sql"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			dir := generatorFixture(t)
			if testCase.removeHead {
				if err := os.Remove(filepath.Join(dir, "002_add_probe_value.sql")); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := generate(options{migrationsDir: dir, versionFile: filepath.Join(dir, "VERSION"), release: true}); err != nil {
				t.Fatalf("generate(-release) error = %v", err)
			}
			if got := strings.Join(listFixture(t, dir, "baseline"), ","); got != testCase.wantBaseline {
				t.Fatalf("baseline files = %q, want %q", got, testCase.wantBaseline)
			}
			if got, want := strings.Join(listFixture(t, dir, "compat"), ","), "README.md"; got != want {
				t.Fatalf("compat files after release = %q, want %q", got, want)
			}
		})
	}
}
