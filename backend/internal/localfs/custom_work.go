package localfs

import (
	"io/fs"
	"os"
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
// Ignored directories (IsIgnoredDirectoryName), hidden folders, and folders it
// cannot read are left out, along with the folders that hold an unreadable
// one. Discovery reads only directory names, like DiscoverFolders, and never
// follows a link.
func DiscoverCustomWorkCandidates(root string, options Options) (CustomWorkDiscovery, error) {
	if options.ScanDepth <= 0 {
		options.ScanDepth = 3
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return CustomWorkDiscovery{}, err
	}
	starts, err := discoveryStarts(absRoot, options.SubRoots)
	if err != nil {
		return CustomWorkDiscovery{}, err
	}
	return discoverCustomWork(absRoot, starts, options.ScanDepth)
}

// CustomWorkCandidateAt reports whether DiscoverCustomWorkCandidates with the
// same options returns the folder at rel, a slash-separated path relative to
// root, and returns that candidate. It reads the listings of the folders above
// it that the full walk reads, matching every name exactly, and walks only the
// folder's own subtree, so its cost does not grow with the rest of the library.
func CustomWorkCandidateAt(root, rel string, options Options) (CustomWorkCandidate, bool, error) {
	if options.ScanDepth <= 0 {
		options.ScanDepth = 3
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return CustomWorkCandidate{}, false, err
	}
	parts := strings.Split(rel, "/")
	if rel == "" || len(parts) > options.ScanDepth {
		return CustomWorkCandidate{}, false, nil
	}
	starts, err := discoveryStarts(absRoot, options.SubRoots)
	if err != nil {
		return CustomWorkCandidate{}, false, err
	}
	// visitFrom indexes the first name the walk visits, the walk start's own or
	// the first below the data root; listFrom the first name it finds by
	// listing a folder rather than as a configured start.
	visitFrom, listFrom := -1, -1
	for _, start := range starts {
		startRel, err := filepath.Rel(absRoot, start)
		if err != nil {
			return CustomWorkCandidate{}, false, err
		}
		startRel = filepath.ToSlash(startRel)
		if startRel == "." {
			visitFrom, listFrom = 0, 0
			break
		}
		if rel == startRel || strings.HasPrefix(rel, startRel+"/") {
			visitFrom = strings.Count(startRel, "/")
			listFrom = visitFrom + 1
			if info, err := os.Lstat(start); err != nil {
				return CustomWorkCandidate{}, false, err
			} else if !info.IsDir() {
				return CustomWorkCandidate{}, false, nil
			}
			break
		}
	}
	if visitFrom < 0 {
		return CustomWorkCandidate{}, false, nil
	}
	for index, part := range parts {
		if strings.HasPrefix(part, ".") {
			return CustomWorkCandidate{}, false, nil
		}
		if index < visitFrom {
			continue
		}
		if code, _ := ExtractWorkCode(part); code != "" || IsIgnoredDirectoryName(part) {
			return CustomWorkCandidate{}, false, nil
		}
		if index < listFrom {
			continue
		}
		listed, err := listsDirectory(filepath.Join(absRoot, filepath.Join(parts[:index]...)), part)
		if err != nil || !listed {
			return CustomWorkCandidate{}, false, err
		}
	}
	discovery, err := discoverCustomWork(absRoot, []string{filepath.Join(absRoot, filepath.FromSlash(rel))}, options.ScanDepth)
	if err != nil {
		return CustomWorkCandidate{}, false, err
	}
	for _, candidate := range discovery.Candidates {
		if candidate.RelPath == rel {
			return candidate, true, nil
		}
	}
	return CustomWorkCandidate{}, false, nil
}

// listsDirectory reports whether the folder at parent can be read and lists a
// directory, not a link, named exactly name. A folder the walk cannot read
// hides everything below it.
func listsDirectory(parent, name string) (bool, error) {
	entries, err := os.ReadDir(parent)
	if err != nil {
		if isSkippableWalkError(err) {
			return false, nil
		}
		return false, err
	}
	for _, entry := range entries {
		if entry.Name() == name {
			return entry.IsDir(), nil
		}
	}
	return false, nil
}

func discoverCustomWork(absRoot string, starts []string, scanDepth int) (CustomWorkDiscovery, error) {
	folders := []CustomWorkCandidate{}
	coded := map[string]bool{}
	codes := map[string]bool{}
	unreadable := map[string]bool{}
	visit := func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && isSkippableWalkError(walkErr) {
				// The walk visits a folder before it reads it, so the folder may
				// already be listed.
				if _, rel, err := relativeDepth(absRoot, current); err == nil && rel != "." {
					unreadable[filepath.ToSlash(rel)] = true
				}
				return filepath.SkipDir
			}
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		if current != absRoot && IsIgnoredDirectoryName(entry.Name()) {
			return filepath.SkipDir
		}
		depth, rel, err := relativeDepth(absRoot, current)
		if err != nil {
			return err
		}
		if depth == 0 {
			return nil
		}
		if depth > scanDepth {
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
	for _, start := range starts {
		if err := filepath.WalkDir(start, visit); err != nil {
			return CustomWorkDiscovery{}, err
		}
	}

	// A folder that holds a work folder would swallow it, so every ancestor of
	// a coded folder is excluded along with the folders inside one. A folder
	// the walk cannot read may hold one, so it is excluded the same way.
	for rel := range unreadable {
		coded[rel] = true
	}
	holdsWork := map[string]bool{}
	for rel := range coded {
		for parent := path.Dir(rel); parent != "." && parent != "/"; parent = path.Dir(parent) {
			holdsWork[parent] = true
		}
	}
	candidates := folders[:0]
	for _, folder := range folders {
		if unreadable[folder.RelPath] || holdsWork[folder.RelPath] || insideCodedOrHidden(folder.RelPath, coded) {
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
