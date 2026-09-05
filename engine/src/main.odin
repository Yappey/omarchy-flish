package main

// Omarchy Flish engine entry point.
//
// The whole session runs out of one arena: parsing a command line, walking the
// VFS, and rendering a hint all allocate freely, and the arena is reset at the
// top of each REPL iteration. That is the reason for choosing a language
// without a garbage collector -- the cost of a turn is a single pointer reset,
// not an unpredictable collection pause in the middle of a child's typing.

import "core:fmt"
import "core:mem"
import "core:os"

import "commands"
import "hints"
import "ipc"
import "session"
import "telemetry"
import "vfs"

// One turn of the REPL should never need more than this. If it does, that is a
// bug in a command, not a reason to grow the arena.
TURN_ARENA_SIZE :: 1 * mem.Megabyte

main :: proc() {
	os.exit(int(run()))
}

run :: proc() -> (exit_code: u8) {
	turn_backing := make([]byte, TURN_ARENA_SIZE)
	defer delete(turn_backing)

	turn_arena: mem.Arena
	mem.arena_init(&turn_arena, turn_backing)

	world := vfs.create_starter_world()
	defer vfs.destroy(&world)

	state := session.create()
	defer session.destroy(&state)

	// Hints are an enhancement, never a dependency. If the tutor is not
	// listening the engine runs exactly as it otherwise would.
	tutor := ipc.connect()
	defer ipc.disconnect(&tutor)

	log := telemetry.open()
	defer telemetry.close(&log)

	dictionary := hints.load_dictionary()
	defer hints.destroy_dictionary(&dictionary)

	fmt.println(BANNER)

	for {
		mem.arena_free_all(&turn_arena)
		context.temp_allocator = mem.arena_allocator(&turn_arena)

		line, ok := read_line()
		if !ok do break // EOF: the child closed the terminal.

		outcome := commands.execute(&world, line)

		// The authentic error goes to the terminal first and always. The tutor
		// translates it afterwards; it never stands in for it.
		commands.print_outcome(outcome)
		session.record(&state, line, outcome)

		if session.should_reset(&state) {
			session.simulate_sigint(&state)
			ipc.dismiss_all(&tutor, state.id)
			continue
		}

		if hint, matched := hints.evaluate(&dictionary, &world, &state, outcome); matched {
			ipc.send_hint(&tutor, hint)
			telemetry.record_hint(&log, hint)
		}
	}

	return 0
}

BANNER :: `Omarchy Flish -- type 'help' to look around, 'exit' to leave.`

// read_line reads one line from stdin, stripped of its trailing newline.
// Returns ok=false at EOF.
read_line :: proc() -> (line: string, ok: bool) {
	// TODO: replace with a real line editor (history, arrow keys, and the
	// mash detection hook that feeds session.simulate_sigint).
	fmt.print(session.PROMPT)
	buffer: [4096]byte
	n, err := os.read(os.stdin, buffer[:])
	if err != nil || n <= 0 do return "", false

	raw := string(buffer[:n])
	for len(raw) > 0 && (raw[len(raw) - 1] == '\n' || raw[len(raw) - 1] == '\r') {
		raw = raw[:len(raw) - 1]
	}
	return raw, true
}
