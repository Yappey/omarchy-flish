package commands

// Command dispatch. Every builtin evaluates against the VFS and returns an
// Outcome; nothing here writes to the terminal, so the same dispatch is usable
// from tests without capturing stdout.

import "core:fmt"
import "core:strings"

import "../vfs"

Status :: enum {
	Ok,
	Not_Found,
	Not_A_Directory,
	Is_A_Directory,
	Permission_Denied,
	Unknown_Command,
	Bad_Usage,
}

Outcome :: struct {
	command: string, // The verb, e.g. "cd".
	argv:    []string,
	status:  Status,
	stdout:  string, // Rendered output, may be empty.
	stderr:  string, // The authentic error line, may be empty.
}

// execute parses and runs one line. All returned strings are allocated in the
// temp allocator, which main resets at the top of each turn.
execute :: proc(world: ^vfs.World, line: string) -> (outcome: Outcome) {
	argv := tokenize(line)
	if len(argv) == 0 do return Outcome{status = .Ok}

	outcome.command = argv[0]
	outcome.argv = argv[1:]

	switch argv[0] {
	case "cd":
		return cmd_cd(world, outcome)
	case "ls":
		return cmd_ls(world, outcome)
	case "cat":
		return cmd_cat(world, outcome)
	case "pwd":
		return cmd_pwd(world, outcome)
	case:
		outcome.status = .Unknown_Command
		outcome.stderr = fmt.tprintf("flish: %s: command not found", argv[0])
		return
	}
}

// print_outcome writes the turn's real output. The authentic error is never
// suppressed, reworded, or replaced by a hint -- reading it is the lesson.
print_outcome :: proc(outcome: Outcome) {
	if outcome.stdout != "" do fmt.println(outcome.stdout)
	if outcome.stderr != "" do fmt.eprintln(outcome.stderr)
}

// ------------------------------------------------------------------- builtins

@(private)
cmd_cd :: proc(world: ^vfs.World, outcome: Outcome) -> Outcome {
	outcome := outcome
	if len(outcome.argv) != 1 {
		outcome.status = .Bad_Usage
		outcome.stderr = "flish: cd: expected one folder name"
		return outcome
	}

	target := outcome.argv[0]
	node := vfs.resolve(world, world.cwd, target)
	if node == nil {
		outcome.status = .Not_Found
		outcome.stderr = fmt.tprintf("flish: cd: %s: No such file or directory", target)
		return outcome
	}
	if !vfs.is_dir(node) {
		outcome.status = .Not_A_Directory
		outcome.stderr = fmt.tprintf("flish: cd: %s: Not a directory", target)
		return outcome
	}

	world.cwd = node
	outcome.status = .Ok
	return outcome
}

@(private)
cmd_ls :: proc(world: ^vfs.World, outcome: Outcome) -> Outcome {
	outcome := outcome
	target := world.cwd
	if len(outcome.argv) == 1 {
		target = vfs.resolve(world, world.cwd, outcome.argv[0])
		if target == nil {
			outcome.status = .Not_Found
			outcome.stderr = fmt.tprintf(
				"flish: ls: cannot access '%s': No such file or directory",
				outcome.argv[0],
			)
			return outcome
		}
	}

	// Real ls on a file prints the file's own name and exits 0. Matching that
	// matters: a child who types `ls secret_map.txt` gets a confusing success,
	// not an error, and that confusion is itself a hint trigger.
	if !vfs.is_dir(target) {
		outcome.stdout = target.name
		outcome.status = .Ok
		return outcome
	}

	names: [dynamic]string
	defer delete(names)
	for child in target.children do append(&names, child.name)

	outcome.stdout = strings.join(names[:], "  ", context.temp_allocator)
	outcome.status = .Ok
	return outcome
}

@(private)
cmd_cat :: proc(world: ^vfs.World, outcome: Outcome) -> Outcome {
	outcome := outcome
	if len(outcome.argv) != 1 {
		outcome.status = .Bad_Usage
		outcome.stderr = "flish: cat: expected one file name"
		return outcome
	}

	target := outcome.argv[0]
	node := vfs.resolve(world, world.cwd, target)
	if node == nil {
		outcome.status = .Not_Found
		outcome.stderr = fmt.tprintf("flish: cat: %s: No such file or directory", target)
		return outcome
	}
	if vfs.is_dir(node) {
		outcome.status = .Is_A_Directory
		outcome.stderr = fmt.tprintf("flish: cat: %s: Is a directory", target)
		return outcome
	}

	outcome.stdout = strings.trim_right_space(node.content)
	outcome.status = .Ok
	return outcome
}

@(private)
cmd_pwd :: proc(world: ^vfs.World, outcome: Outcome) -> Outcome {
	outcome := outcome
	outcome.stdout = vfs.path_of(world.cwd, context.temp_allocator)
	outcome.status = .Ok
	return outcome
}

// -------------------------------------------------------------------- parsing

// tokenize splits on whitespace. Quoting and globbing are deliberately absent
// until a scenario needs them; every feature added here is a concept the child
// can now trip over.
@(private)
tokenize :: proc(line: string) -> []string {
	fields, err := strings.fields(line, context.temp_allocator)
	if err != nil do return nil
	return fields
}
