package tests

// The sandbox guarantee is the one property worth testing before anything else:
// no path a child can type may resolve outside the in-memory tree.

import "core:testing"

import "../src/vfs"

@(test)
resolve_stays_inside_the_sandbox :: proc(t: ^testing.T) {
	world := vfs.create_starter_world()
	defer vfs.destroy(&world)

	// `..` past the root is a no-op, not an escape.
	node := vfs.resolve(&world, world.cwd, "../../../../etc/passwd")
	testing.expect(t, node == nil, "a path climbing past the root must not resolve")
}

@(test)
cd_into_a_file_is_not_a_directory :: proc(t: ^testing.T) {
	world := vfs.create_starter_world()
	defer vfs.destroy(&world)

	treasure := vfs.resolve(&world, world.cwd, "treasure_island")
	testing.expect(t, vfs.is_dir(treasure), "treasure_island should be a directory")

	map_file := vfs.resolve(&world, treasure, "secret_map.txt")
	testing.expect(t, map_file != nil, "secret_map.txt should resolve")
	testing.expect(t, !vfs.is_dir(map_file), "secret_map.txt is a file, not a directory")
}
