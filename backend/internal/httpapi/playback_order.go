package httpapi

import (
	"regexp"
	"sort"
	"strings"
)

// The work playback order is the order the work page's Directory lists a
// work's files in, from its whole local tree: every file sits at its first
// playable location, inside the work's own folder; a work whose local files
// lie in several work folders shows one labeled folder per copy; chains of
// single folders collapse into one; and each folder lists its subfolders, then
// its files, each in natural name order. The client builds the same tree from
// the work media for the Directory; Resume queues the work in this order.

// playbackTreeFile is a work file at its place in the work's tree.
type playbackTreeFile struct {
	item     *mediaItemDetail
	location fileLocationDetail
	// title is the file's real name and displayTitle the name the viewer's
	// metadata languages give it, when that differs.
	title        string
	displayTitle string
	// folderPath is the file's folder in the tree, before chains of single
	// folders collapse; sourcePath adds its name.
	folderPath string
	sourcePath string
	streamURL  string
}

type playbackTreeNode struct {
	name     string
	children map[string]*playbackTreeNode
	// order keeps the children in the order they were first seen.
	order []string
	files []*playbackTreeFile
}

func newPlaybackTreeNode(name string) *playbackTreeNode {
	return &playbackTreeNode{name: name, children: map[string]*playbackTreeNode{}}
}

func (node *playbackTreeNode) child(name string) *playbackTreeNode {
	if existing, ok := node.children[name]; ok {
		return existing
	}
	created := newPlaybackTreeNode(name)
	node.children[name] = created
	node.order = append(node.order, name)
	return created
}

// workPlaybackTree places a work's media items in its tree. files lists them
// in the order the work media does.
type workPlaybackTree struct {
	root  *playbackTreeNode
	files []*playbackTreeFile
	// byLocation finds a file by the location it sits at.
	byLocation map[int64]*playbackTreeFile
	byItem     map[int64]*playbackTreeFile
}

// treeLocation is the location that places an item in the tree: an available
// one with a stream, then an available remote download, then any available
// one, then a remote one that can play.
func treeLocation(item mediaItemDetail) (fileLocationDetail, bool) {
	matchers := []func(fileLocationDetail) bool{
		func(location fileLocationDetail) bool {
			return location.Availability == "available" && location.StreamURL != ""
		},
		func(location fileLocationDetail) bool {
			return location.Availability == "available" && location.LocationType == "remote_stream" && location.DownloadURL != ""
		},
		func(location fileLocationDetail) bool { return location.Availability == "available" },
		func(location fileLocationDetail) bool {
			return location.Availability == "remote" && (location.StreamURL != "" || location.DownloadURL != "")
		},
	}
	for _, matches := range matchers {
		for _, location := range item.Locations {
			if matches(location) {
				return location, true
			}
		}
	}
	return fileLocationDetail{}, false
}

func buildWorkPlaybackTree(items []mediaItemDetail, workCode string) workPlaybackTree {
	tree := workPlaybackTree{root: newPlaybackTreeNode(""), byLocation: map[int64]*playbackTreeFile{}, byItem: map[int64]*playbackTreeFile{}}
	labels := localWorkFolderLabels(items, workCode)
	for index := range items {
		item := &items[index]
		location, ok := treeLocation(*item)
		if !ok {
			continue
		}
		parts := displayPathParts(location.Path, location.LocationType, workCode, labels)
		names := displayPathNames(location, len(parts))
		file := &playbackTreeFile{item: item, location: location, title: item.Title}
		if len(parts) > 0 {
			file.title = parts[len(parts)-1]
			file.displayTitle = names[len(names)-1]
			parts = parts[:len(parts)-1]
		}
		node := tree.root
		for _, part := range parts {
			node = node.child(part)
		}
		file.folderPath = strings.Join(parts, "/")
		file.sourcePath = file.title
		if len(parts) > 0 {
			file.sourcePath = file.folderPath + "/" + file.title
		}
		file.streamURL = locationPlaybackURL(location, item.Kind)
		node.files = append(node.files, file)
		tree.files = append(tree.files, file)
		tree.byLocation[location.ID] = file
		tree.byItem[item.ID] = file
	}
	return tree
}

// playableFiles lists the audio files, and video files with sound, that can
// play now, in the work playback order.
func (tree workPlaybackTree) playableFiles() []*playbackTreeFile {
	files := []*playbackTreeFile{}
	var visit func(node *playbackTreeNode)
	visit = func(node *playbackTreeNode) {
		children := make([]*playbackTreeNode, 0, len(node.order))
		for _, name := range node.order {
			children = append(children, node.children[name])
		}
		sort.SliceStable(children, func(i, j int) bool { return naturalNameCompare(children[i].name, children[j].name) < 0 })
		for _, child := range children {
			visit(child)
		}
		own := append([]*playbackTreeFile{}, node.files...)
		sort.SliceStable(own, func(i, j int) bool { return naturalNameCompare(own[i].title, own[j].title) < 0 })
		for _, file := range own {
			if file.playable() {
				files = append(files, file)
			}
		}
	}
	visit(normalizePlaybackTree(tree.root))
	return files
}

func (file *playbackTreeFile) playable() bool {
	kind := file.item.Kind
	hasSound := kind == "audio" || (kind == "video" && (file.item.HasAudio == nil || *file.item.HasAudio))
	return hasSound && playbackLocationUsable(file.location.Availability) && file.streamURL != ""
}

// normalizePlaybackTree drops leading folders that only hold one folder that
// itself only holds one folder, then collapses every chain of single folders
// below the top level into one folder named by their joined names.
func normalizePlaybackTree(root *playbackTreeNode) *playbackTreeNode {
	for len(root.files) == 0 && len(root.order) == 1 {
		only := root.children[root.order[0]]
		if len(only.files) > 0 || len(only.order) != 1 {
			break
		}
		root = only
	}
	return collapseSinglePlaybackFolders(root, true)
}

func collapseSinglePlaybackFolders(node *playbackTreeNode, isRoot bool) *playbackTreeNode {
	collapsed := &playbackTreeNode{name: node.name, children: map[string]*playbackTreeNode{}, files: node.files}
	for _, name := range node.order {
		next := collapseSinglePlaybackFolders(node.children[name], false)
		for !isRoot && len(next.files) == 0 && len(next.order) == 1 {
			grandChild := next.children[next.order[0]]
			renamed := *grandChild
			renamed.name = next.name + "/" + grandChild.name
			next = collapseSinglePlaybackFolders(&renamed, false)
		}
		if _, exists := collapsed.children[next.name]; !exists {
			collapsed.order = append(collapsed.order, next.name)
		}
		collapsed.children[next.name] = next
	}
	return collapsed
}

var workCodePattern = regexp.MustCompile(`(?i)\b(RJ|BJ|VJ)[0-9]{5,8}\b`)

func splitPathSegments(path string) []string {
	parts := []string{}
	for _, part := range strings.Split(path, "/") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

// localWorkRootIndex is the index of the path segment that is the work's
// folder, or -1 when no segment names the work.
func localWorkRootIndex(parts []string, workCode string) int {
	code := strings.ToUpper(workCode)
	for index, part := range parts {
		if strings.Contains(strings.ToUpper(part), code) || workCodePattern.MatchString(part) {
			return index
		}
	}
	return -1
}

// displayPathParts are the segments a location's file has in the tree: below
// the work's folder for a local file, under its label when the work has
// several work folders.
func displayPathParts(path string, locationType string, workCode string, labels map[string]string) []string {
	parts := splitPathSegments(path)
	if locationType != "local" || workCode == "" {
		return parts
	}
	rootIndex := localWorkRootIndex(parts, workCode)
	if rootIndex < 0 || rootIndex >= len(parts)-1 {
		return parts
	}
	inside := append([]string{}, parts[rootIndex+1:]...)
	if label := labels[strings.Join(parts[:rootIndex+1], "/")]; label != "" {
		return append([]string{label}, inside...)
	}
	return inside
}

// displayPathNames are the display names of the last count segments of a
// location's path, empty where a segment keeps its real name.
func displayPathNames(location fileLocationDetail, count int) []string {
	names := make([]string, count)
	if location.DisplayPath == "" {
		return names
	}
	real := splitPathSegments(location.Path)
	shown := splitPathSegments(location.DisplayPath)
	if len(real) != len(shown) || count > len(real) {
		return names
	}
	offset := len(real) - count
	for index := 0; index < count; index++ {
		if shown[offset+index] != real[offset+index] {
			names[index] = shown[offset+index]
		}
	}
	return names
}

// localWorkFolderLabels names each work folder when a work's available local
// files lie in several: the folder's name, extended by its parent folders
// while two folders share a name.
func localWorkFolderLabels(items []mediaItemDetail, workCode string) map[string]string {
	if workCode == "" {
		return nil
	}
	roots := []string{}
	seen := map[string]bool{}
	for _, item := range items {
		for _, location := range item.Locations {
			if location.LocationType != "local" || location.Availability != "available" {
				continue
			}
			parts := splitPathSegments(location.Path)
			index := localWorkRootIndex(parts, workCode)
			if index < 0 || index >= len(parts)-1 {
				continue
			}
			root := strings.Join(parts[:index+1], "/")
			if !seen[root] {
				seen[root] = true
				roots = append(roots, root)
			}
		}
	}
	if len(roots) < 2 {
		return nil
	}
	suffix := func(root string, depth int) string {
		segments := strings.Split(root, "/")
		if depth > len(segments) {
			depth = len(segments)
		}
		return strings.Join(segments[len(segments)-depth:], " / ")
	}
	labels := map[string]string{}
	for _, root := range roots {
		segments := strings.Split(root, "/")
		depth := 1
		for depth < len(segments) {
			shared := false
			for _, other := range roots {
				if other != root && suffix(other, depth) == suffix(root, depth) {
					shared = true
					break
				}
			}
			if !shared {
				break
			}
			depth++
		}
		labels[root] = suffix(root, depth)
	}
	return labels
}
