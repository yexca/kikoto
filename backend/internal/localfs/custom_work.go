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
	// Containers are the folders a candidate would be if they held no work
	// folder or unreadable folder.
	Containers []CustomWorkCandidate
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
	if rel == "" || len(strings.Split(rel, "/")) > options.ScanDepth {
		return CustomWorkCandidate{}, false, nil
	}
	absRoot, visible, err := customWorkFolderVisible(root, rel, options)
	if err != nil || !visible {
		return CustomWorkCandidate{}, false, err
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

// CustomWorkFolderNode is a folder the custom work folder tree shows: a
// candidate, or a folder that holds a work folder and is shown only so the
// candidates beside or below that work folder can be reached.
type CustomWorkFolderNode struct {
	Name string
	// RelPath is slash-separated and relative to the scanned root.
	RelPath string
	// Candidate reports whether DiscoverCustomWorkCandidates returns the folder.
	Candidate bool
	// HasChildren reports whether the tree shows folders inside it.
	HasChildren bool
}

// CustomWorkFolderChildren returns the folders directly inside rel that the
// custom work folder tree shows, by the rules of DiscoverCustomWorkCandidates:
// every candidate and every folder on the way to one. A folder that carries a
// work code or lies inside one, and a hidden, ignored, or unreadable folder,
// is left out. An empty rel lists the top level of the walk starts. It reads
// the folders above rel like CustomWorkCandidateAt and walks only rel's own
// subtree. It reports false when the tree does not show rel.
func CustomWorkFolderChildren(root, rel string, options Options) ([]CustomWorkFolderNode, bool, error) {
	if options.ScanDepth <= 0 {
		options.ScanDepth = 3
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, false, err
	}
	var starts []string
	parent := "."
	if rel == "" {
		if starts, err = discoveryStarts(absRoot, options.SubRoots); err != nil {
			return nil, false, err
		}
	} else {
		var visible bool
		if absRoot, visible, err = customWorkFolderVisible(root, rel, options); err != nil || !visible {
			return nil, false, err
		}
		if len(strings.Split(rel, "/")) >= options.ScanDepth {
			return []CustomWorkFolderNode{}, true, nil
		}
		starts, parent = []string{filepath.Join(absRoot, filepath.FromSlash(rel))}, rel
	}
	discovery, err := discoverCustomWork(absRoot, starts, options.ScanDepth)
	if err != nil {
		return nil, false, err
	}
	// Every folder the tree shows has its parent shown too, so a folder has
	// children exactly when some shown folder names it as its parent.
	hasChildren := map[string]bool{}
	for _, folders := range [][]CustomWorkCandidate{discovery.Candidates, discovery.Containers} {
		for _, folder := range folders {
			hasChildren[path.Dir(folder.RelPath)] = true
		}
	}
	nodes := []CustomWorkFolderNode{}
	for index, folders := range [][]CustomWorkCandidate{discovery.Candidates, discovery.Containers} {
		for _, folder := range folders {
			if path.Dir(folder.RelPath) != parent {
				continue
			}
			nodes = append(nodes, CustomWorkFolderNode{
				Name:        folder.Name,
				RelPath:     folder.RelPath,
				Candidate:   index == 0,
				HasChildren: hasChildren[folder.RelPath],
			})
		}
	}
	sort.Slice(nodes, func(i, j int) bool {
		left, right := strings.ToLower(nodes[i].Name), strings.ToLower(nodes[j].Name)
		if left != right {
			return left < right
		}
		return nodes[i].Name < nodes[j].Name
	})
	return nodes, true, nil
}

// customWorkFolderVisible reports whether the full candidate walk with the
// same options would visit the folder at rel and could list it as a candidate
// or as a folder on the way to one: it lies under a walk start, no name on its
// path is hidden, ignored, or carries a work code, and every folder above it
// lists the next one as a directory rather than a link. It returns the
// absolute data root.
func customWorkFolderVisible(root, rel string, options Options) (string, bool, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", false, err
	}
	parts := strings.Split(rel, "/")
	starts, err := discoveryStarts(absRoot, options.SubRoots)
	if err != nil {
		return "", false, err
	}
	// visitFrom indexes the first name the walk visits, the walk start's own or
	// the first below the data root; listFrom the first name it finds by
	// listing a folder rather than as a configured start.
	visitFrom, listFrom := -1, -1
	for _, start := range starts {
		startRel, err := filepath.Rel(absRoot, start)
		if err != nil {
			return "", false, err
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
				return "", false, err
			} else if !info.IsDir() {
				return "", false, nil
			}
			break
		}
	}
	if visitFrom < 0 {
		return "", false, nil
	}
	for index, part := range parts {
		if strings.HasPrefix(part, ".") {
			return "", false, nil
		}
		if index < visitFrom {
			continue
		}
		if code, _ := ExtractWorkCode(part); code != "" || IsIgnoredDirectoryName(part) {
			return "", false, nil
		}
		if index < listFrom {
			continue
		}
		listed, err := listsDirectory(filepath.Join(absRoot, filepath.Join(parts[:index]...)), part)
		if err != nil || !listed {
			return "", false, err
		}
	}
	return absRoot, true, nil
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
	candidates, containers := []CustomWorkCandidate{}, []CustomWorkCandidate{}
	for _, folder := range folders {
		if unreadable[folder.RelPath] || insideCodedOrHidden(folder.RelPath, coded) {
			continue
		}
		if holdsWork[folder.RelPath] {
			containers = append(containers, folder)
			continue
		}
		candidates = append(candidates, folder)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].RelPath < candidates[j].RelPath })
	sort.Slice(containers, func(i, j int) bool { return containers[i].RelPath < containers[j].RelPath })
	return CustomWorkDiscovery{Candidates: candidates, Containers: containers, Codes: codes}, nil
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
