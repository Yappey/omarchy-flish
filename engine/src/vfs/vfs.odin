package vfs

// The sandbox. Every path a child types resolves inside this in-memory tree and
// nowhere else -- there is no syscall in this package that touches the real
// filesystem, and there must never be one. That property is the entire safety
// argument for the product, so it is worth guarding in review.

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

// create_starter_world builds the world a child lands in on first run.
//
// TODO: this is a placeholder shape. The real starter world is content, not
// code, and should be loaded from a scenario file so it can be edited without
// a rebuild.
create_starter_world :: proc() -> (world: World) {
	world.root = make_node("/", .Directory)

	home := add_dir(world.root, "home")
	treasure := add_dir(home, "treasure_island")
	add_file(treasure, "secret_map.txt", "X marks the spot, three steps east of the palm.\n")
	add_dir(treasure, "caves")

	world.cwd = home
	return
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
