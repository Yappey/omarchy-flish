package telemetry

// Local-first telemetry. Every event is appended to an NDJSON file under XDG
// state; nothing leaves the machine unless an adult has opted in, and even then
// only as a background batch. Nothing here may ever block the REPL.

import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:strings"
import "core:time"

import "../hints"

Log :: struct {
	handle:  os.Handle,
	path:    string,
	enabled: bool,
}

Event :: struct {
	at:       string, // RFC 3339.
	kind:     string, // "hint_shown" | "feedback" | "command_failed"
	session:  string,
	hint_id:  string `json:",omitempty"`,
	template: string `json:",omitempty"`,
	verdict:  string `json:",omitempty"`,
}

// open prepares the local log. A failure disables telemetry silently -- an
// unwritable state directory must not stop a child from using the terminal.
open :: proc() -> (log: Log) {
	log.path = log_path()

	dir := state_dir()
	defer delete(dir)
	if os.make_directory(dir) != nil {
		// Already existing is fine; anything else shows up as a failed open.
	}

	handle, err := os.open(log.path, os.O_WRONLY | os.O_CREATE | os.O_APPEND, 0o600)
	if err != nil do return

	log.handle = handle
	log.enabled = true
	return
}

close :: proc(log: ^Log) {
	if log.enabled do os.close(log.handle)
	log.enabled = false
	delete(log.path)
}

record_hint :: proc(log: ^Log, hint: hints.Hint) {
	write(
		log,
		Event {
			at = now_rfc3339(),
			kind = "hint_shown",
			session = hint.session,
			hint_id = hint.id,
			template = hint.template,
		},
	)
}

record_feedback :: proc(log: ^Log, session_id, hint_id, verdict: string) {
	write(
		log,
		Event {
			at = now_rfc3339(),
			kind = "feedback",
			session = session_id,
			hint_id = hint_id,
			verdict = verdict,
		},
	)
}

// --------------------------------------------------------------------- detail

@(private)
write :: proc(log: ^Log, event: Event) {
	if !log.enabled do return

	data, err := json.marshal(event, allocator = context.temp_allocator)
	if err != nil do return

	line := strings.concatenate({string(data), "\n"}, context.temp_allocator)
	os.write_string(log.handle, line)
}

@(private)
state_dir :: proc() -> string {
	if dir := os.get_env("XDG_STATE_HOME"); dir != "" {
		defer delete(dir)
		return fmt.aprintf("%s/omarchy-flish", dir)
	}
	home := os.get_env("HOME")
	defer delete(home)
	return fmt.aprintf("%s/.local/state/omarchy-flish", home)
}

@(private)
log_path :: proc() -> string {
	dir := state_dir()
	defer delete(dir)
	return fmt.aprintf("%s/telemetry.ndjson", dir)
}

@(private)
now_rfc3339 :: proc() -> string {
	// TODO: real RFC 3339 formatting. core:time gives the components; this is
	// a placeholder so the field is never empty in early logs.
	return fmt.tprintf("%d", time.to_unix_seconds(time.now()))
}
