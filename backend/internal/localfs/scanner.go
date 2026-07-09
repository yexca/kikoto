package localfs

import (
	"io/fs"
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
		options.ScanDepth = 2
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
	matches := workCodePattern.FindAllStringSubmatch(name, -1)
	if len(matches) == 0 {
		return "", false
	}

	code := strings.ToUpper(matches[0][1]) + matches[0][2]
	return code, len(matches) > 1
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
