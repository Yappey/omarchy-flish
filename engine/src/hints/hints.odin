package hints

// The deterministic "AI". A dictionary of curated templates is matched against
// the failing command, its authentic error, and the shape of the VFS around it.
// There is no model here and there must never be one at runtime -- see
// docs/decisions.md, D1.

import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:slice"
import "core:strings"

import "../commands"
import "../session"
import "../vfs"

// Hint is the rendered, ready-to-display unit. By the time a Hint exists, all
// substitution is done: the tutor renders text and nothing else.
Hint :: struct {
	id:       string,
	session:  string,
	template: string,
	title:    string,
	body:     string,
	ttl_ms:   int,
}

// Matcher mirrors templates/schema/hint.schema.json. Keep the two in step; the
// schema is the contract with the templates repository, this is only its
// in-memory form.
Matcher :: struct {
	command: string, // Exact verb, e.g. "cd".
	status:  string, // commands.Status name, e.g. "Not_A_Directory".
	stderr:  string, // Optional regex over the authentic error line.
}

// Decorator is a question about the world at the moment of failure. It is what
// separates "you typed cd at a file" from "you typed cd at nothing", which are
// the same error string but different lessons.
Decorator :: struct {
	target_exists:       Maybe(bool),
	target_is_file:      Maybe(bool),
	cwd_has_children:    Maybe(bool),
	target_near_sibling: Maybe(bool),
	target_in_parent:    Maybe(bool),
	cwd_is_root:         Maybe(bool),
	target_is_empty_dir: Maybe(bool),
	argv_count:          Maybe(int),
}

Template :: struct {
	schema_version: int,
	id:             string,
	match:          Matcher,
	requires:       Decorator,
	min_strike:     int,
	title:          string,
	body:           string, // May contain {{target}}.
	ttl_ms:         int,
}

Dictionary :: struct {
	templates: [dynamic]Template,
	source:    string, // Where they were loaded from, for diagnostics.
}

// load_dictionary reads every template the system knows about. Missing or
// malformed files are a developer problem, never a child's: on failure the
// dictionary is simply empty and no hints fire.
load_dictionary :: proc() -> (dictionary: Dictionary) {
	dictionary.source = dictionary_dir()

	handle, err := os.open(dictionary.source)
	if err != nil do return
	defer os.close(handle)

	entries, read_err := os.read_dir(handle, -1)
	if read_err != nil do return
	defer os.file_info_slice_delete(entries)

	for entry in entries {
		if filepath.ext(entry.name) != ".json" do continue
		load_file(&dictionary, entry.fullpath)
	}

	// Precedence must not depend on the order the filesystem handed back, or
	// the same mistake yields different hints on different machines and D1 --
	// the determinism the whole product rests on -- quietly stops being true.
	slice.sort_by(dictionary.templates[:], template_precedes)
	return
}

// template_precedes orders the dictionary most-specific first, so the template
// that makes the strongest claim about the world wins when several match.
//
// Ties break on id: arbitrary, but stable everywhere, which is the property
// that actually matters. Two templates tying on both is a dictionary bug and is
// caught by the ambiguity test in tests/templates/.
@(private)
template_precedes :: proc(a, b: Template) -> bool {
	sa, sb := specificity(a), specificity(b)
	if sa != sb do return sa > sb
	if a.min_strike != b.min_strike do return a.min_strike < b.min_strike
	return a.id < b.id
}

// specificity counts the conditions a template asserts. Pinning the command,
// the status and two decorators is a narrower claim than pinning the command
// alone, and the narrower claim is the more considered lesson.
@(private)
specificity :: proc(template: Template) -> (score: int) {
	if template.match.command != "" do score += 1
	if template.match.status != "" do score += 1
	if template.match.stderr != "" do score += 1

	if _, ok := template.requires.target_exists.?; ok do score += 1
	if _, ok := template.requires.target_is_file.?; ok do score += 1
	if _, ok := template.requires.cwd_has_children.?; ok do score += 1
	if _, ok := template.requires.target_near_sibling.?; ok do score += 1
	if _, ok := template.requires.target_in_parent.?; ok do score += 1
	if _, ok := template.requires.cwd_is_root.?; ok do score += 1
	if _, ok := template.requires.target_is_empty_dir.?; ok do score += 1
	if _, ok := template.requires.argv_count.?; ok do score += 1
	return
}

destroy_dictionary :: proc(dictionary: ^Dictionary) {
	delete(dictionary.templates)
	delete(dictionary.source)
}

// evaluate returns the hint for this turn, if any. Returning matched=false is
// the common and correct case: an unrecognised failure produces no hint rather
// than a guessed one.
evaluate :: proc(
	dictionary: ^Dictionary,
	world: ^vfs.World,
	state: ^session.State,
	outcome: commands.Outcome,
) -> (
	hint: Hint,
	matched: bool,
) {
	if outcome.status == .Ok do return
	if !session.can_hint(state) do return

	strikes := session.strike_count(state)

	// The dictionary is sorted most-specific-first at load, so the first
	// template that matches and has earned its strikes is the right one.
	for template in dictionary.templates {
		if strikes < template.min_strike do continue
		if session.already_shown(state, template.id) do continue
		if !matches(template, world, outcome) do continue

		session.mark_shown(state, template.id)
		session.mark_hinted(state)
		return render(template, state, outcome), true
	}
	return
}

// --------------------------------------------------------------------- detail

@(private)
matches :: proc(template: Template, world: ^vfs.World, outcome: commands.Outcome) -> bool {
	if template.match.command != "" && template.match.command != outcome.command do return false
	if template.match.status != "" && template.match.status != status_name(outcome.status) do return false

	// TODO: `match.stderr` is a regex in the schema but is compared literally
	// here. Wire it to core:text/regex once the decision in docs/decisions.md
	// D2 is settled -- confirm that package's capture-group support covers the
	// {{target}} extraction the templates assume, or bind PCRE2 instead.
	if template.match.stderr != "" && !strings.contains(outcome.stderr, template.match.stderr) {
		return false
	}

	return satisfies(template.requires, world, outcome)
}

@(private)
satisfies :: proc(requires: Decorator, world: ^vfs.World, outcome: commands.Outcome) -> bool {
	// Both forms are needed: the resolved node answers "what is it", the raw
	// text answers "what did they type", and a near-miss has no node at all.
	name: string
	target: ^vfs.Node
	if len(outcome.argv) > 0 {
		name = outcome.argv[0]
		target = vfs.resolve(world, world.cwd, name)
	}

	if want, ok := requires.target_exists.?; ok {
		if (target != nil) != want do return false
	}
	if want, ok := requires.target_is_file.?; ok {
		if (target != nil && target.kind == .File) != want do return false
	}
	if want, ok := requires.cwd_has_children.?; ok {
		if (len(world.cwd.children) > 0) != want do return false
	}
	if want, ok := requires.target_near_sibling.?; ok {
		if vfs.has_near_sibling(world.cwd, name) != want do return false
	}
	if want, ok := requires.target_in_parent.?; ok {
		if vfs.exists_in_parent(world.cwd, name) != want do return false
	}
	if want, ok := requires.cwd_is_root.?; ok {
		if vfs.is_root(world, world.cwd) != want do return false
	}
	if want, ok := requires.target_is_empty_dir.?; ok {
		if vfs.is_empty_dir(target) != want do return false
	}
	if want, ok := requires.argv_count.?; ok {
		if len(outcome.argv) != want do return false
	}
	return true
}

@(private)
render :: proc(
	template: Template,
	state: ^session.State,
	outcome: commands.Outcome,
) -> (
	hint: Hint,
) {
	target := len(outcome.argv) > 0 ? outcome.argv[0] : ""

	hint.id = fmt.aprintf("%s-%s-%d", state.id, template.id, state.turns)
	hint.session = state.id
	hint.template = template.id
	hint.title = strings.clone(template.title)
	hint.body, _ = strings.replace_all(template.body, "{{target}}", target)
	hint.ttl_ms = template.ttl_ms if template.ttl_ms > 0 else 12000
	return
}

destroy_hint :: proc(hint: ^Hint) {
	delete(hint.id)
	delete(hint.title)
	delete(hint.body)
}

@(private)
status_name :: proc(status: commands.Status) -> string {
	return fmt.tprintf("%v", status)
}

@(private)
load_file :: proc(dictionary: ^Dictionary, path: string) {
	data, ok := os.read_entire_file(path)
	if !ok do return
	defer delete(data)

	template: Template
	if json.unmarshal(data, &template) != nil do return
	if template.schema_version != 1 do return
	if template.id == "" do return

	// The schema documents a default of 3, but json.unmarshal leaves an absent
	// field at zero -- which would fire every such template on the first
	// failure, before the child has had a chance to work it out themselves.
	if template.min_strike <= 0 do template.min_strike = session.STRIKE_THRESHOLD

	append(&dictionary.templates, template)
}

// dictionary_dir resolves where shipped templates live. During development that
// is the checkout's templates/hints; installed, it is the packaged copy.
@(private)
dictionary_dir :: proc() -> string {
	if override := os.get_env("FLISH_TEMPLATES_DIR"); override != "" do return override
	return strings.clone("/usr/share/omarchy-flish/templates/hints")
}
