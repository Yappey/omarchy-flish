package vfs

// The sandbox. Every path a child types resolves inside this in-memory tree and
// nowhere else -- there is no syscall in this package that touches the real
// filesystem, and there must never be one. That property is the entire safety
// argument for the product, so it is worth guarding in review.

import "core:encoding/json"
import "core:os"
import "core:strings"

Node_Kind :: enum {
	File,
	Directory,
}

Node :: struct {
	name:     string,
	kind:     Node_Kind,
	content:  string, // Files only.
	children: [dynamic]^Node, // Directories only.
	parent:   ^Node, // nil for the root.
}

World :: struct {
	root: ^Node,
	cwd:  ^Node,
}

// ------------------------------------------------------------------ scenarios

// The on-disk shape of templates/schema/scenario.schema.json. The world is
// content, not code: a scenario author edits JSON and needs no compiler, and
// the same file doubles as the fixture a hint's decorators are tested against.
Scenario_Entry :: struct {
	name:    string,
	kind:    string, // "file" | "dir"
	content: string, // files only
	entries: []Scenario_Entry, // directories only
}

Scenario :: struct {
	schema_version: int,
	id:             string,
	name:           string,
	description:    string,
	cwd:            string,
	entries:        []Scenario_Entry,
}

// scenario_dir resolves where shipped scenarios live, mirroring the templates
// lookup in hints.dictionary_dir.
scenario_dir :: proc(allocator := context.allocator) -> string {
	if override := os.get_env("FLISH_SCENARIOS_DIR", allocator); override != "" {
		return override
	}
	return strings.clone("/usr/share/omarchy-flish/templates/scenarios", allocator)
}

// load_scenario builds a world from a scenario file. Unlike a missing tutor
// socket, a missing world is not a degraded mode: there is no product without
// one, so the caller is expected to fail loudly rather than substitute
// something. That keeps a packaging mistake from reaching a child as a
// mysteriously empty island.
load_scenario :: proc(path: string) -> (world: World, ok: bool) {
	data, read_ok := os.read_entire_file(path)
	if !read_ok do return
	defer delete(data)

	scenario: Scenario
	if json.unmarshal(data, &scenario) != nil do return
	if scenario.schema_version != 1 do return

	world.root = make_node("/", .Directory)
	build_entries(world.root, scenario.entries)

	start := resolve(&world, world.root, scenario.cwd)
	if start == nil || !is_dir(start) {
		destroy(&world)
		return
	}
	world.cwd = start
	return world, true
}

@(private)
build_entries :: proc(parent: ^Node, entries: []Scenario_Entry) {
	for entry in entries {
		if entry.kind == "dir" {
			dir := add_dir(parent, entry.name)
			build_entries(dir, entry.entries)
		} else {
			add_file(parent, entry.name, entry.content)
		}
	}
}

destroy :: proc(world: ^World) {
	if world.root != nil do destroy_node(world.root)
	world.root = nil
	world.cwd = nil
}

// resolve walks a path from `from`, or from the root when the path is absolute.
// Returns nil when any segment is missing or when a non-final segment is a file.
resolve :: proc(world: ^World, from: ^Node, path: string) -> ^Node {
	if path == "" do return from

	current := from
	rest := path
	if strings.has_prefix(path, "/") {
		current = world.root
		rest = path[1:]
	}

	for segment in strings.split_iterator(&rest, "/") {
		switch segment {
		case "", ".":
			continue
		case "..":
			if current.parent != nil do current = current.parent
			continue
		}
		if current.kind != .Directory do return nil
		child := find_child(current, segment)
		if child == nil do return nil
		current = child
	}
	return current
}

find_child :: proc(dir: ^Node, name: string) -> ^Node {
	if dir == nil || dir.kind != .Directory do return nil
	for child in dir.children {
		if child.name == name do return child
	}
	return nil
}

is_dir :: proc(node: ^Node) -> bool {
	return node != nil && node.kind == .Directory
}

is_empty_dir :: proc(node: ^Node) -> bool {
	return is_dir(node) && len(node.children) == 0
}

is_root :: proc(world: ^World, node: ^Node) -> bool {
	return node != nil && node == world.root
}

// --------------------------------------------------------------- decorators
//
// Questions about the world at the moment of failure. These are what let two
// failures that print the same error be two different lessons -- see
// templates/schema/hint.schema.json.

// has_near_sibling reports whether `dir` holds a name that is a plausible typo
// of `name`. This is the difference between "that does not exist" and "you
// almost had it", which for a 7-12 year old are not the same problem at all.
//
// Distance 1 for short names, 2 for longer ones: on a four-letter name, two
// edits is most of the word and stops being a typo.
has_near_sibling :: proc(dir: ^Node, name: string) -> bool {
	return near_sibling(dir, name) != nil
}

// near_sibling returns the closest plausible typo of `name` in `dir`, or nil.
//
// Callers need the node and not just a yes: almost-typing a folder name and
// almost-typing a file name are different lessons. The first means walk into
// it; the second means fix the spelling and read it again. A decorator that
// cannot tell them apart sends a child to retry `cat` on a directory.
near_sibling :: proc(dir: ^Node, name: string) -> ^Node {
	if !is_dir(dir) || name == "" do return nil
	limit := len(name) <= 4 ? 1 : 2

	best: ^Node
	best_distance := limit + 1
	for child in dir.children {
		if child.name == name do continue
		distance := edit_distance(child.name, name)
		if distance <= limit && distance < best_distance {
			best = child
			best_distance = distance
		}
	}
	return best
}

// exists_in_parent reports whether the name the child asked for is one level
// up: they are in the wrong room, not chasing something imaginary.
exists_in_parent :: proc(dir: ^Node, name: string) -> bool {
	if dir == nil || dir.parent == nil || name == "" do return false
	return find_child(dir.parent, name) != nil
}

// edit_distance is plain Levenshtein over bytes. Scenario names are ASCII by
// schema, and the two rows are temp-allocated so the turn arena reclaims them.
edit_distance :: proc(a, b: string) -> int {
	la, lb := len(a), len(b)
	if la == 0 do return lb
	if lb == 0 do return la

	prev := make([]int, lb + 1, context.temp_allocator)
	curr := make([]int, lb + 1, context.temp_allocator)
	for j in 0 ..= lb do prev[j] = j

	for i in 1 ..= la {
		curr[0] = i
		for j in 1 ..= lb {
			cost := a[i - 1] == b[j - 1] ? 0 : 1

			best := prev[j] + 1
			if curr[j - 1] + 1 < best do best = curr[j - 1] + 1
			if prev[j - 1] + cost < best do best = prev[j - 1] + cost
			curr[j] = best
		}
		copy(prev, curr)
	}
	return prev[lb]
}

// path_of renders an absolute path for a node. The caller owns the result.
path_of :: proc(node: ^Node, allocator := context.allocator) -> string {
	if node == nil do return ""

	segments: [dynamic]string
	defer delete(segments)
	for cursor := node; cursor != nil && cursor.parent != nil; cursor = cursor.parent {
		append(&segments, cursor.name)
	}
	if len(segments) == 0 do return strings.clone("/", allocator)

	builder := strings.builder_make(allocator)
	#reverse for segment in segments {
		strings.write_byte(&builder, '/')
		strings.write_string(&builder, segment)
	}
	return strings.to_string(builder)
}

// --------------------------------------------------------------- construction

add_dir :: proc(parent: ^Node, name: string) -> ^Node {
	return attach(parent, make_node(name, .Directory))
}

add_file :: proc(parent: ^Node, name: string, content: string) -> ^Node {
	node := make_node(name, .File)
	node.content = strings.clone(content)
	return attach(parent, node)
}

@(private)
make_node :: proc(name: string, kind: Node_Kind) -> ^Node {
	node := new(Node)
	node.name = strings.clone(name)
	node.kind = kind
	return node
}

@(private)
attach :: proc(parent: ^Node, child: ^Node) -> ^Node {
	child.parent = parent
	append(&parent.children, child)
	return child
}

@(private)
destroy_node :: proc(node: ^Node) {
	for child in node.children do destroy_node(child)
	delete(node.children)
	delete(node.name)
	if node.kind == .File do delete(node.content)
	free(node)
}
