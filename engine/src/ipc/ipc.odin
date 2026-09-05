package ipc

// The engine's half of docs/ipc-protocol.md. The tutor listens; this connects.
//
// Every procedure here is best-effort by contract. A missing tutor, a refused
// connection, or a socket that fills up must all leave the REPL running exactly
// as it would otherwise, and must never print anything to the child's terminal.

import "core:encoding/json"
import "core:fmt"
import "core:net"
import "core:os"
import "core:strings"

import "../hints"

PROTOCOL_VERSION :: 1

Conn :: struct {
	socket:    net.TCP_Socket, // Placeholder; see the TODO on connect.
	connected: bool,
	path:      string,
}

// socket_path resolves $XDG_RUNTIME_DIR/omarchy-flish/tutor.sock, falling back
// to /run/user/$UID when the variable is unset.
socket_path :: proc(allocator := context.allocator) -> string {
	if dir := os.get_env("XDG_RUNTIME_DIR", allocator); dir != "" {
		defer delete(dir, allocator)
		return fmt.aprintf("%s/omarchy-flish/tutor.sock", dir, allocator = allocator)
	}
	return fmt.aprintf("/run/user/%d/omarchy-flish/tutor.sock", os.getuid(), allocator = allocator)
}

// connect attaches to the tutor if it is there. A failure is normal and silent.
connect :: proc() -> (conn: Conn) {
	conn.path = socket_path()

	// TODO: core:net has no Unix-domain socket type yet. Bind socket(2) /
	// connect(2) with AF_UNIX through core:sys/linux here. Until then the
	// engine runs permanently in degraded mode, which is the correct default
	// and keeps the REPL fully testable without a desktop session.
	conn.connected = false
	return
}

disconnect :: proc(conn: ^Conn) {
	conn.connected = false
	delete(conn.path)
}

send_hint :: proc(conn: ^Conn, hint: hints.Hint) {
	if !conn.connected do return

	payload := Hint_Message {
		v        = PROTOCOL_VERSION,
		type     = "hint",
		id       = hint.id,
		session  = hint.session,
		template = hint.template,
		title    = hint.title,
		body     = hint.body,
		actions  = {"helpful", "confusing"},
		ttl_ms   = hint.ttl_ms,
	}
	send(conn, payload)
}

// dismiss_all retracts anything still on screen for this session -- used when a
// simulated SIGINT clears the child's slate.
dismiss_all :: proc(conn: ^Conn, session_id: string) {
	if !conn.connected do return
	send(conn, Dismiss_Message{v = PROTOCOL_VERSION, type = "dismiss", session = session_id})
}

// ------------------------------------------------------------------- messages

Hint_Message :: struct {
	v:        int,
	type:     string,
	id:       string,
	session:  string,
	template: string,
	title:    string,
	body:     string,
	actions:  []string,
	ttl_ms:   int,
}

Dismiss_Message :: struct {
	v:       int,
	type:    string,
	id:      string `json:",omitempty"`,
	session: string,
}

Feedback_Message :: struct {
	v:       int,
	type:    string,
	id:      string,
	verdict: string, // "helpful" | "confusing"
	at:      string, // RFC 3339.
}

// --------------------------------------------------------------------- detail

@(private)
send :: proc(conn: ^Conn, payload: $T) {
	data, err := json.marshal(payload, allocator = context.temp_allocator)
	if err != nil do return

	line := strings.concatenate({string(data), "\n"}, context.temp_allocator)
	// TODO: write `line` to the connected Unix socket, non-blocking. A short
	// write is dropped rather than retried: a hint that misses its moment is
	// worthless, and blocking the REPL to deliver it is worse than losing it.
	_ = line
}
