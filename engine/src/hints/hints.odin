package hints

// The deterministic "AI". A dictionary of curated templates is matched against
// the failing command, its authentic error, and the shape of the VFS around it.
// There is no model here and there must never be one at runtime -- see
// docs/decisions.md, D1.

import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:path/filepath"
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
	target_exists: Maybe(bool),
	target_is_file: Maybe(bool),
	cwd_has_children: Maybe(bool),
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
	if !session.at_threshold(state) do return
	if outcome.status == .Ok do return

	for template in dictionary.templates {
		if session.already_shown(state, template.id) do continue
		if !matches(template, world, outcome) do continue

		session.mark_shown(state, template.id)
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
	target: ^vfs.Node
	if len(outcome.argv) > 0 {
		target = vfs.resolve(world, world.cwd, outcome.argv[0])
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

	append(&dictionary.templates, template)
}

// dictionary_dir resolves where shipped templates live. During development that
// is the checkout's templates/hints; installed, it is the packaged copy.
@(private)
dictionary_dir :: proc() -> string {
	if override := os.get_env("FLISH_TEMPLATES_DIR"); override != "" do return override
	return strings.clone("/usr/share/omarchy-flish/templates/hints")
}
