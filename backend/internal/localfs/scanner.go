package localfs

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var workCodePattern = regexp.MustCompile(`(?i)(RJ|BJ|VJ|CC)[\s_-]?([0-9]{5,8})`)

type WorkFolder struct {
	Code    string
	Title   string
	AbsPath string
	RelPath string
	Depth   int
	Files   []LocalFile
}

type LocalFile struct {
	AbsPath         string
	RelPath         string
	WorkRelPath     string
	Title           string
	Extension       string
	SizeBytes       int64
	DurationSeconds *int64
	HasAudio        *bool
}

type Summary struct {
	CandidateFolders int
	DetectedWorks    int
	ScannedFiles     int
	AmbiguousFolders []string
	DuplicateGroups  []DuplicateGroup
}

type DuplicateGroup struct {
	Code    string
	Folders []WorkFolder
}

type Options struct {
	ScanDepth       int
	AudioExtensions []string
}

func Discover(root string, options Options) ([]WorkFolder, Summary, error) {
	workFolders, summary, err := DiscoverFolders(root, options)
	if err != nil {
		return nil, Summary{}, err
	}
	for i := range workFolders {
		files, err := CollectWorkFiles(root, workFolders[i].AbsPath)
		if err != nil {
			return nil, Summary{}, err
		}
		workFolders[i].Files = files
		summary.ScannedFiles += len(files)
	}
	return workFolders, summary, nil
}

func DiscoverFolders(root string, options Options) ([]WorkFolder, Summary, error) {
	if options.ScanDepth <= 0 {
		options.ScanDepth = 3
	}

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, Summary{}, err
	}

	var summary Summary
	var candidates []WorkFolder
	err = filepath.WalkDir(absRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		if path != absRoot && isKikotoInternalDirectory(entry.Name()) {
			return filepath.SkipDir
		}

		depth, rel, err := relativeDepth(absRoot, path)
		if err != nil {
			return err
		}
		if depth == 0 {
			return nil
		}
		if depth > options.ScanDepth {
			return filepath.SkipDir
		}

		code, ambiguous := ExtractWorkCode(entry.Name())
		if code == "" {
			return nil
		}
		if ambiguous {
			summary.AmbiguousFolders = append(summary.AmbiguousFolders, rel)
		}

		candidates = append(candidates, WorkFolder{
			Code:    code,
			Title:   strings.TrimSpace(entry.Name()),
			AbsPath: path,
			RelPath: filepath.ToSlash(rel),
			Depth:   depth,
		})
		return nil
	})
	if err != nil {
		return nil, Summary{}, err
	}

	summary.CandidateFolders = len(candidates)
	workFolders := chooseDeepest(candidates)
	summary.DuplicateGroups = duplicateGroups(workFolders)

	sort.Slice(workFolders, func(i, j int) bool {
		return workFolders[i].RelPath < workFolders[j].RelPath
	})
	summary.DetectedWorks = len(workFolders)
	return workFolders, summary, nil
}

// DiscoverChangedFolders resolves work roots touched by a bounded set of
// relative filesystem paths. It walks only changed directory subtrees and the
// candidate ancestors of each path; it never traverses an unaffected work's
// media tree.
func DiscoverChangedFolders(root string, options Options, changedPaths []string) ([]WorkFolder, Summary, error) {
	discovery, err := newChangedFolderDiscovery(root, options.ScanDepth)
	if err != nil {
		return nil, Summary{}, err
	}
	scopes := map[string]string{}

	for _, changedPath := range changedPaths {
		absPath, rel, err := discovery.resolveChangedPath(changedPath)
		if err != nil {
			return nil, Summary{}, err
		}
		if err := discovery.addAncestorCandidates(rel); err != nil {
			return nil, Summary{}, err
		}
		isDirectory, err := changedPathIsDirectory(absPath)
		if err != nil {
			return nil, Summary{}, err
		}
		if isDirectory {
			scopes[strings.ToLower(absPath)] = absPath
		}
	}

	for _, scope := range minimalChangedScopes(scopes) {
		if err := discovery.walkScope(scope); err != nil {
			return nil, Summary{}, err
		}
	}
	return discovery.result()
}

type changedFolderDiscovery struct {
	absRoot    string
	scanDepth  int
	candidates map[string]WorkFolder
	ambiguous  map[string]bool
}

func newChangedFolderDiscovery(root string, scanDepth int) (*changedFolderDiscovery, error) {
	if scanDepth <= 0 {
		scanDepth = 3
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &changedFolderDiscovery{
		absRoot: absRoot, scanDepth: scanDepth,
		candidates: map[string]WorkFolder{}, ambiguous: map[string]bool{},
	}, nil
}

func (discovery *changedFolderDiscovery) resolveChangedPath(changedPath string) (string, string, error) {
	rel := filepath.Clean(filepath.FromSlash(strings.TrimSpace(changedPath)))
	if rel == "." || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", invalidChangedPath(changedPath)
	}
	absPath := filepath.Clean(filepath.Join(discovery.absRoot, rel))
	if !isAncestorOrSame(discovery.absRoot, absPath) {
		return "", "", invalidChangedPath(changedPath)
	}
	return absPath, rel, nil
}

func invalidChangedPath(path string) error {
	return &fs.PathError{Op: "resolve changed path", Path: path, Err: fs.ErrInvalid}
}

func (discovery *changedFolderDiscovery) addAncestorCandidates(rel string) error {
	ancestor := discovery.absRoot
	parts := strings.Split(rel, string(filepath.Separator))
	for index, part := range parts {
		if index >= discovery.scanDepth {
			break
		}
		ancestor = filepath.Join(ancestor, part)
		if err := discovery.addCandidate(ancestor); err != nil {
			return err
		}
	}
	return nil
}

func changedPathIsDirectory(path string) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.IsDir(), nil
}

func minimalChangedScopes(scopes map[string]string) []string {
	scopePaths := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		scopePaths = append(scopePaths, scope)
	}
	sort.Slice(scopePaths, func(i, j int) bool { return len(scopePaths[i]) < len(scopePaths[j]) })
	selected := make([]string, 0, len(scopePaths))
	for _, scope := range scopePaths {
		covered := false
		for _, parent := range selected {
			if isAncestorOrSame(parent, scope) {
				covered = true
				break
			}
		}
		if !covered {
			selected = append(selected, scope)
		}
	}
	return selected
}

func (discovery *changedFolderDiscovery) walkScope(scope string) error {
	return filepath.WalkDir(scope, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		if path != discovery.absRoot && isKikotoInternalDirectory(entry.Name()) {
			return filepath.SkipDir
		}
		depth, _, err := relativeDepth(discovery.absRoot, path)
		if err != nil {
			return err
		}
		if depth > discovery.scanDepth {
			return filepath.SkipDir
		}
		return discovery.addCandidate(path)
	})
}

func (discovery *changedFolderDiscovery) addCandidate(path string) error {
	depth, rel, err := relativeDepth(discovery.absRoot, path)
	if err != nil {
		return err
	}
	if depth <= 0 || depth > discovery.scanDepth {
		return nil
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return nil
	}
	code, hasMultipleCodes := ExtractWorkCode(filepath.Base(path))
	if code == "" {
		return nil
	}
	cleanPath := filepath.Clean(path)
	discovery.candidates[strings.ToLower(cleanPath)] = WorkFolder{
		Code: code, Title: strings.TrimSpace(filepath.Base(path)), AbsPath: cleanPath,
		RelPath: filepath.ToSlash(rel), Depth: depth,
	}
	if hasMultipleCodes {
		discovery.ambiguous[filepath.ToSlash(rel)] = true
	}
	return nil
}

func (discovery *changedFolderDiscovery) result() ([]WorkFolder, Summary, error) {
	candidateList := make([]WorkFolder, 0, len(discovery.candidates))
	for _, candidate := range discovery.candidates {
		candidateList = append(candidateList, candidate)
	}
	workFolders := chooseDeepest(candidateList)
	sort.Slice(workFolders, func(i, j int) bool { return workFolders[i].RelPath < workFolders[j].RelPath })
	ambiguousFolders := make([]string, 0, len(discovery.ambiguous))
	for rel := range discovery.ambiguous {
		ambiguousFolders = append(ambiguousFolders, rel)
	}
	sort.Strings(ambiguousFolders)
	return workFolders, Summary{
		CandidateFolders: len(candidateList), DetectedWorks: len(workFolders),
		AmbiguousFolders: ambiguousFolders, DuplicateGroups: duplicateGroups(workFolders),
	}, nil
}

func isKikotoInternalDirectory(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case ".kikoto-staging", ".kikoto-backup", ".kikoto-trash":
		return true
	default:
		return false
	}
}

func duplicateGroups(folders []WorkFolder) []DuplicateGroup {
	byCode := map[string][]WorkFolder{}
	for _, folder := range folders {
		byCode[folder.Code] = append(byCode[folder.Code], folder)
	}
	groups := []DuplicateGroup{}
	for code, items := range byCode {
		if len(items) < 2 {
			continue
		}
		sort.Slice(items, func(i, j int) bool {
			if items[i].Depth == items[j].Depth {
				return items[i].RelPath < items[j].RelPath
			}
			return items[i].Depth < items[j].Depth
		})
		groups = append(groups, DuplicateGroup{Code: code, Folders: items})
	}
	sort.Slice(groups, func(i, j int) bool {
		return groups[i].Code < groups[j].Code
	})
	return groups
}

func ExtractWorkCode(name string) (string, bool) {
	indices := workCodePattern.FindAllStringSubmatchIndex(name, -1)
	codes := make([]string, 0, len(indices))
	for _, match := range indices {
		if match[1] < len(name) && name[match[1]] >= '0' && name[match[1]] <= '9' {
			continue
		}
		codes = append(codes, strings.ToUpper(name[match[2]:match[3]])+name[match[4]:match[5]])
	}
	if len(codes) == 0 {
		return "", false
	}

	return codes[0], len(codes) > 1
}

func chooseDeepest(candidates []WorkFolder) []WorkFolder {
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Depth == candidates[j].Depth {
			return len(candidates[i].RelPath) > len(candidates[j].RelPath)
		}
		return candidates[i].Depth > candidates[j].Depth
	})

	chosen := make([]WorkFolder, 0, len(candidates))
	for _, candidate := range candidates {
		overlaps := false
		for _, existing := range chosen {
			if isAncestorOrSame(candidate.AbsPath, existing.AbsPath) || isAncestorOrSame(existing.AbsPath, candidate.AbsPath) {
				overlaps = true
				break
			}
		}
		if !overlaps {
			chosen = append(chosen, candidate)
		}
	}
	return chosen
}

func CollectWorkFiles(root string, workPath string) ([]LocalFile, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	absWorkPath, err := filepath.Abs(workPath)
	if err != nil {
		return nil, err
	}
	return collectFiles(absRoot, absWorkPath)
}

func collectFiles(root string, workPath string) ([]LocalFile, error) {
	files := []LocalFile{}
	err := filepath.WalkDir(workPath, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}

		info, err := entry.Info()
		if err != nil {
			return err
		}
		rootRel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		workRel, err := filepath.Rel(workPath, path)
		if err != nil {
			return err
		}

		extension := strings.ToLower(filepath.Ext(workRel))
		title := strings.TrimSuffix(filepath.ToSlash(workRel), extension)
		files = append(files, LocalFile{
			AbsPath:     path,
			RelPath:     filepath.ToSlash(rootRel),
			WorkRelPath: filepath.ToSlash(workRel),
			Title:       title,
			Extension:   extension,
			SizeBytes:   info.Size(),
		})
		return nil
	})
	sort.Slice(files, func(i, j int) bool {
		return files[i].WorkRelPath < files[j].WorkRelPath
	})
	return files, err
}

func normalizeExtensions(values []string) map[string]struct{} {
	extensions := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(strings.ToLower(value))
		if value == "" {
			continue
		}
		if !strings.HasPrefix(value, ".") {
			value = "." + value
		}
		extensions[value] = struct{}{}
	}
	return extensions
}

func relativeDepth(root string, path string) (int, string, error) {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return 0, "", err
	}
	if rel == "." {
		return 0, rel, nil
	}
	return len(strings.Split(rel, string(filepath.Separator))), rel, nil
}

func isAncestorOrSame(parent string, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
