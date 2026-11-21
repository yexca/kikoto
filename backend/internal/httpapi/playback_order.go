package httpapi

import (
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/naturalorder"
)

// The work playback order is the order the work page's Directory lists a
// work's files in, from its whole local tree: every file sits at its first
// playable location, inside the recorded work folder that holds it; a work
// whose local files lie in several work folders shows one labeled folder per
// folder; chains of single folders collapse into one; and each folder lists its
// subfolders, then its files, each in natural name order. The client builds
// the same tree from the same folder ids and relative paths for the
// Directory; Resume and queue resolve play in this order.

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

// buildWorkPlaybackTree places a work's files as the work page's Directory
// does, by the work folder the server attached to each local location, so
// Resume and the queue play in the order the Directory shows.
func buildWorkPlaybackTree(items []mediaItemDetail) workPlaybackTree {
	tree := workPlaybackTree{root: newPlaybackTreeNode(""), byLocation: map[int64]*playbackTreeFile{}, byItem: map[int64]*playbackTreeFile{}}
	labels := localWorkFolderLabels(items)
	for index := range items {
		item := &items[index]
		location, ok := treeLocation(*item)
		if !ok {
			continue
		}
		parts := displayPathParts(location, labels)
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
		sort.SliceStable(children, func(i, j int) bool { return naturalorder.Compare(children[i].name, children[j].name) < 0 })
		for _, child := range children {
			visit(child)
		}
		own := append([]*playbackTreeFile{}, node.files...)
		sort.SliceStable(own, func(i, j int) bool { return naturalorder.Compare(own[i].title, own[j].title) < 0 })
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

func splitPathSegments(path string) []string {
	parts := []string{}
	for _, part := range strings.Split(path, "/") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

// localFolderPlace is the work folder the server attached to a local location
// and the path segments below it, when one holds it.
func localFolderPlace(location fileLocationDetail) (int64, []string, bool) {
	if location.LocationType != "local" || location.FolderID == nil {
		return 0, nil, false
	}
	parts := splitPathSegments(location.RelativePath)
	if len(parts) == 0 {
		return 0, nil, false
	}
	return *location.FolderID, parts, true
}

// displayPathParts are the segments a location's file has in the tree, as the
// Directory places it: below the work folder that holds a local file, under
// that folder's label when the work's files lie in several, and any other
// path whole.
func displayPathParts(location fileLocationDetail, labels map[int64]string) []string {
	folderID, parts, ok := localFolderPlace(location)
	if !ok {
		return splitPathSegments(location.Path)
	}
	if label := labels[folderID]; label != "" {
		return append([]string{label}, parts...)
	}
	return parts
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

// localWorkFolderLabels names each work folder that holds an available local
// file when a work's files lie in several, keyed by folder: the folder's name,
// extended by its parent folders while two folders share a name.
func localWorkFolderLabels(items []mediaItemDetail) map[int64]string {
	roots := map[int64]string{}
	order := []int64{}
	for _, item := range items {
		for _, location := range item.Locations {
			if location.Availability != "available" {
				continue
			}
			folderID, inside, ok := localFolderPlace(location)
			if _, seen := roots[folderID]; !ok || seen {
				continue
			}
			// The location gives the path below the folder, so the rest is the folder's root.
			parts := splitPathSegments(location.Path)
			rootLength := max(0, len(parts)-len(inside))
			roots[folderID] = strings.Join(parts[:rootLength], "/")
			order = append(order, folderID)
		}
	}
	if len(roots) < 2 {
		return nil
	}
	suffix := func(root string, depth int) string {
		segments := strings.Split(root, "/")
		return strings.Join(segments[max(0, len(segments)-depth):], " / ")
	}
	labels := map[int64]string{}
	for _, folderID := range order {
		root := roots[folderID]
		segments := strings.Split(root, "/")
		depth := 1
		for depth < len(segments) {
			shared := false
			for other, otherRoot := range roots {
				if other != folderID && suffix(otherRoot, depth) == suffix(root, depth) {
					shared = true
					break
				}
			}
			if !shared {
				break
			}
			depth++
		}
		labels[folderID] = suffix(root, depth)
	}
	return labels
}
