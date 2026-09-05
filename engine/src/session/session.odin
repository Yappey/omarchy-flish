package session

// Per-terminal state: what the child has tried, how many times in a row it has
// failed the same way, and whether they have stopped making progress and
// started mashing.

import "core:fmt"
import "core:strings"
import "core:time"

import "../commands"

PROMPT :: "flish> "

// Three strikes before a hint fires. Fewer feels like the app is answering for
// them; more and they have already given up.
STRIKE_THRESHOLD :: 3

// A run of inputs that parse as nothing at all. Below this, a child is
// experimenting; at it, they are mashing and the screen needs clearing.
MASH_THRESHOLD :: 3

Strike :: struct {
	signature: string, // What "the same mistake again" means, see signature_of.
	count:     int,
	last_line: string,
	last_at:   time.Time,
}

State :: struct {
	id:         string, // Stable for the life of the process; stamped on telemetry.
	started_at: time.Time,
	turns:      int,
	strike:     Strike,
	mash_run:   int,
	reset_due:  bool,
	// Hints already shown this session, so the same one is not repeated at
	// every subsequent strike.
	shown:      map[string]bool,
}

create :: proc() -> (state: State) {
	state.id = new_session_id()
	state.started_at = time.now()
	state.shown = make(map[string]bool)
	return
}

destroy :: proc(state: ^State) {
	delete(state.shown)
	delete(state.id)
	if state.strike.signature != "" do delete(state.strike.signature)
	if state.strike.last_line != "" do delete(state.strike.last_line)
}

// record folds one turn into the session. It owns copies of what it keeps,
// because the outcome's strings live in the turn arena and are gone next loop.
record :: proc(state: ^State, line: string, outcome: commands.Outcome) {
	state.turns += 1

	if looks_like_mashing(line, outcome) {
		state.mash_run += 1
		if state.mash_run >= MASH_THRESHOLD do state.reset_due = true
	} else {
		state.mash_run = 0
	}

	if outcome.status == .Ok {
		clear_strike(state)
		return
	}

	signature := signature_of(outcome)
	defer delete(signature)

	if state.strike.signature == signature {
		state.strike.count += 1
	} else {
		clear_strike(state)
		state.strike.signature = strings.clone(signature)
		state.strike.count = 1
	}

	if state.strike.last_line != "" do delete(state.strike.last_line)
	state.strike.last_line = strings.clone(line)
	state.strike.last_at = time.now()
}

// at_threshold reports whether this turn is the one that earns a hint. It is
// true only on the turn the count reaches the threshold, not on every turn
// after -- a child stuck for ten turns should not get ten popups.
at_threshold :: proc(state: ^State) -> bool {
	return state.strike.count == STRIKE_THRESHOLD
}

should_reset :: proc(state: ^State) -> bool {
	return state.reset_due
}

// simulate_sigint clears the screen state the way a real ^C does: the input is
// abandoned, nothing is executed, and the child gets a clean prompt. It is a
// cognitive-load release valve, not an error.
simulate_sigint :: proc(state: ^State) {
	fmt.println("^C")
	state.mash_run = 0
	state.reset_due = false
	clear_strike(state)
}

mark_shown :: proc(state: ^State, template_id: string) {
	state.shown[strings.clone(template_id)] = true
}

already_shown :: proc(state: ^State, template_id: string) -> bool {
	return template_id in state.shown
}

// --------------------------------------------------------------------- detail

// signature_of decides what counts as "the same mistake". Keying on the verb
// and the failure kind -- not the argument -- means three different wrong
// folder names still add up to three strikes, which is the behaviour a child
// who is lost actually produces.
@(private)
signature_of :: proc(outcome: commands.Outcome) -> string {
	return fmt.aprintf("%s/%v", outcome.command, outcome.status)
}

@(private)
clear_strike :: proc(state: ^State) {
	if state.strike.signature != "" do delete(state.strike.signature)
	if state.strike.last_line != "" do delete(state.strike.last_line)
	state.strike = Strike{}
}

// looks_like_mashing is deliberately conservative. A slow, bad typist must not
// be told to stop; only input that is not plausibly an attempt at a word
// counts.
//
// TODO: the thresholds here are guesses. They should be fixed against real
// telemetry before this ships -- see docs/decisions.md, D4.
@(private)
looks_like_mashing :: proc(line: string, outcome: commands.Outcome) -> bool {
	if outcome.status != .Unknown_Command do return false

	trimmed := strings.trim_space(line)
	if len(trimmed) < 5 do return false
	if strings.contains(trimmed, " ") do return false

	vowels := 0
	for r in trimmed {
		switch r {
		case 'a', 'e', 'i', 'o', 'u', 'y':
			vowels += 1
		}
	}
	// Real commands and real words have vowels. Keyboard rows do not.
	return vowels * 5 < len(trimmed)
}

@(private)
new_session_id :: proc() -> string {
	return fmt.aprintf("%d", time.to_unix_nanoseconds(time.now()))
}
