package localfs

import (
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// CustomWorkCandidate is a folder that can become a custom work.
type CustomWorkCandidate struct {
	Name    string
	AbsPath string
	// RelPath is slash-separated and relative to the scanned root.
	RelPath string
	Depth   int
}

// CustomWorkDiscovery lists the folders that can become custom works and the
// work codes folder names within the scan depth already carry.
type CustomWorkDiscovery struct {
	Candidates []CustomWorkCandidate
	Codes      map[string]bool
}

// DiscoverCustomWorkCandidates returns the folders within the scan depth that
// a scan holds as no work and that hold no work folder: neither the folder nor
// any ancestor or descendant within the depth carries a work code in its name.
// Kikoto's own directories and hidden folders are left out. Discovery reads
// only directory names, like DiscoverFolders, and never follows a link.
func DiscoverCustomWorkCandidates(root string, options Options) (CustomWorkDiscovery, error) {
	if options.ScanDepth <= 0 {
		options.ScanDepth = 3
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return CustomWorkDiscovery{}, err
	}
	folders := []CustomWorkCandidate{}
	coded := map[string]bool{}
	codes := map[string]bool{}
	visit := func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		if current != absRoot && isKikotoInternalDirectory(entry.Name()) {
			return filepath.SkipDir
		}
		depth, rel, err := relativeDepth(absRoot, current)
		if err != nil {
			return err
		}
		if depth == 0 {
			return nil
		}
		if depth > options.ScanDepth {
			return filepath.SkipDir
		}
		rel = filepath.ToSlash(rel)
		if code, _ := ExtractWorkCode(entry.Name()); code != "" {
			coded[rel] = true
			codes[code] = true
			return nil
		}
		folders = append(folders, CustomWorkCandidate{Name: entry.Name(), AbsPath: current, RelPath: rel, Depth: depth})
		return nil
	}
	starts, err := discoveryStarts(absRoot, options.SubRoots)
	if err != nil {
		return CustomWorkDiscovery{}, err
	}
	for _, start := range starts {
		if err := filepath.WalkDir(start, visit); err != nil {
			return CustomWorkDiscovery{}, err
		}
	}

	// A folder that holds a work folder would swallow it, so every ancestor of
	// a coded folder is excluded along with the folders inside one.
	holdsWork := map[string]bool{}
	for rel := range coded {
		for parent := path.Dir(rel); parent != "." && parent != "/"; parent = path.Dir(parent) {
			holdsWork[parent] = true
		}
	}
	candidates := folders[:0]
	for _, folder := range folders {
		if holdsWork[folder.RelPath] || insideCodedOrHidden(folder.RelPath, coded) {
			continue
		}
		candidates = append(candidates, folder)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].RelPath < candidates[j].RelPath })
	return CustomWorkDiscovery{Candidates: candidates, Codes: codes}, nil
}

func insideCodedOrHidden(rel string, coded map[string]bool) bool {
	if strings.HasPrefix(path.Base(rel), ".") {
		return true
	}
	for parent := path.Dir(rel); parent != "." && parent != "/"; parent = path.Dir(parent) {
		if coded[parent] || strings.HasPrefix(path.Base(parent), ".") {
			return true
		}
	}
	return false
}
