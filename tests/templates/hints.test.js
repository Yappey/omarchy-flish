// Tests for templates/hints/*.json -- the shipped hint dictionary.
//
// These guard the rules in templates/README.md that the JSON Schema cannot
// express. Everything here is pure data: no engine, no compiler, no desktop.
//
// When templates/ splits into its own repository, this file goes with it.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve, basename } from "node:path"
import Ajv from "ajv/dist/2020.js"   // the schema declares draft 2020-12

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "..", "..")
const hintsDir = resolve(repo, "templates", "hints")
const schemaPath = resolve(repo, "templates", "schema", "hint.schema.json")

const schema = JSON.parse(readFileSync(schemaPath, "utf8"))
const files = readdirSync(hintsDir).filter((f) => f.endsWith(".json")).sort()
const hints = files.map((f) => ({
  file: f,
  id: basename(f, ".json"),
  data: JSON.parse(readFileSync(resolve(hintsDir, f), "utf8"))
}))

test("there is at least one hint to validate", () => {
  assert.ok(hints.length > 0, `no templates found in ${hintsDir}`)
})

test("every hint validates against templates/schema/hint.schema.json", () => {
  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)
  for (const { file, data } of hints) {
    if (!validate(data)) {
      assert.fail(`${file}:\n` + validate.errors
        .map((e) => `  ${e.instancePath || "/"} ${e.message}`).join("\n"))
    }
  }
})

test("hint id matches its filename", () => {
  for (const { file, id, data } of hints) {
    assert.equal(data.id, id, `${file} declares id "${data.id}"`)
  }
})

test("hint ids are unique", () => {
  const seen = new Map()
  for (const { file, data } of hints) {
    assert.ok(!seen.has(data.id), `id "${data.id}" used by both ${seen.get(data.id)} and ${file}`)
    seen.set(data.id, file)
  }
})

// Telemetry references template ids, so an id that changes meaning silently
// corrupts the curation loop. Renaming copy means a new id, not a reused one.
test("hint ids are stable, lowercase, hyphenated", () => {
  for (const { file, data } of hints) {
    assert.match(data.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${file} has a non-conforming id`)
  }
})

// {{target}} renders from outcome.argv[0]. On a slot with no target -- a bad
// argument count, an unrecognised verb -- that is the empty string, so the hint
// ships with a hole in the sentence. slots.json knows which slots have one.
test("every placeholder can render to something", () => {
  for (const { file, data } of hints) {
    const problems = placeholderProblems(data, knownSlots.get(slotKeyOf(data)))
    assert.deepEqual(problems, [], `${file}: ${problems.join("; ")}`)
  }
})

// The same predicate the drafting gate runs, so a rule cannot be tightened for
// candidates and left loose for what is already committed.
test("{{near}} needs the decorator that guarantees it AND a raised min_strike", () => {
  const slot = { has_target: true }
  const body = "Did you mean {{near}}?"
  const near = { body, requires: { target_near_sibling: true } }

  // Naming the correction ends the thinking, so it is the second hint, not the
  // first. Both conditions are required and each is reported on its own.
  assert.deepEqual(placeholderProblems({ ...near, min_strike: 5 }, slot), [])
  assert.equal(placeholderProblems(near, slot).length, 1, "default min_strike is too soon")
  assert.equal(placeholderProblems({ ...near, min_strike: 3 }, slot).length, 1)
  assert.equal(placeholderProblems({ body, min_strike: 5 }, slot).length, 1, "no decorator")
  assert.equal(placeholderProblems({ body }, slot).length, 2, "neither")
  assert.equal(
    placeholderProblems({ body, min_strike: 5, requires: { cwd_has_files: true } }, slot).length, 1)
})

import { findRunnableCommand, asksAQuestion, findLiteralFilename, findScenarioName, findJargon, findUngroundedAssumption, findContradictedDecorator } from "../helpers/no-do.js"
import { knownSlots, slotKeyOf, scenarioNames, forbiddenWords, placeholderProblems } from "../helpers/dictionary.js"

test("no hint body contains a runnable command line (No-Do)", () => {
  for (const { file, data } of hints) {
    const found = findRunnableCommand(data.body)
    assert.equal(found, null,
      `${file} violates No-Do: ${found}\n  body: ${data.body}`)
  }
})

// Guard the guard: if the predicate stops catching these, it is not doing
// anything and the rule quietly stops being enforced.
test("every hint asks rather than tells", () => {
  for (const { file, data } of hints) {
    assert.ok(asksAQuestion(data.body),
      `${file} contains no question mark, so it explains instead of asking:\n  ${data.body}`)
  }
})

test("no hint names a file literally instead of using {{target}}", () => {
  for (const { file, data } of hints) {
    const literal = findLiteralFilename(data.body)
    assert.equal(literal, null,
      `${file} names "${literal}" literally, so it would be wrong in every ` +
      `scenario but the one it was written against:\n  ${data.body}`)
  }
})

test("no hint names something from a scenario", () => {
  for (const { file, data } of hints) {
    const found = findScenarioName(data.body, scenarioNames)
    assert.equal(found, null,
      `${file} names "${found}", which exists only in one scenario:\n  ${data.body}`)
  }
})

test("the scenario-name check ignores placeholders and partial words", () => {
  const names = new Set(["caves", "secret_map.txt"])
  assert.equal(findScenarioName("Is {{target}} a folder?", names), null)
  assert.equal(findScenarioName("Think about cavespeak.", names), null)
  assert.equal(findScenarioName("You saw: cat: caves: Is a directory", names), "caves")
  assert.equal(findScenarioName("Did you mean secret_map.txt?", names), "secret_map.txt")
})

test("no hint speaks the matcher's vocabulary at the child", () => {
  for (const { file, data } of hints) {
    const found = findJargon(data.body, forbiddenWords)
    assert.equal(found, null, `${file} uses "${found}":\n  ${data.body}`)
  }
})

test("the jargon check keeps the words the error itself uses", () => {
  assert.equal(findJargon("The terminal said Not a directory. What is {{target}}?", forbiddenWords), null)
  assert.equal(findJargon("Is the file in another folder?", forbiddenWords), null)
  assert.equal(findJargon("Try checking siblings or moving up directories.", forbiddenWords), "siblings")
  assert.equal(findJargon("If the target you gave is empty, what then?", forbiddenWords), "target")
})

test("the literal-filename check tolerates ordinary punctuation", () => {
  assert.equal(findLiteralFilename("It is a directory. What command lists it?"), null)
  assert.equal(findLiteralFilename("Is {{target}} spelled correctly?"), null)
  assert.equal(findLiteralFilename("You typed tresure_map.txt but meant another."), "tresure_map.txt")
  assert.equal(findLiteralFilename("Did you mean secret_map.txt?"), "secret_map.txt")
})

test("the No-Do predicate catches known violations", () => {
  const violations = [
    "Try cd .. to go back up a level.",
    "Type cat secret_map.txt and see what happens.",
    "Use cd {{target}} instead.",
    "Run `ls` to see the files.",
    "At the prompt: $ ls -la",
    "You could use ls -l here.",
    "find . -name secret_map.txt",
    "touch ./notes.txt",
    "If you want to see its contents, use 'ls caves'.",
    "Try running ls treasure_island to look.",
    "You could type cat notes and see."
  ]
  for (const v of violations) {
    assert.notEqual(findRunnableCommand(v), null, `should have been caught: ${v}`)
  }
})

test("the No-Do predicate allows a named verb without its argument", () => {
  // D3 relaxed: naming the verb does not give the answer away, because the
  // child still has to supply the target. A verb with its argument attached
  // does, and stays rejected by the cases above.
  for (const ok of [
    "That is a folder. Which command lists what is inside one -- ls?",
    "cd moves you into a folder. Where do you want to go?",
    "Is ls the tool for looking, or cd for moving?"
  ]) {
    assert.equal(findRunnableCommand(ok), null, `should have been allowed: ${ok}`)
  }
})

test("the No-Do predicate allows Socratic prose that names commands", () => {
  const allowed = [
    "Which command shows you what is written inside something?",
    "The terminal said Not a directory. Is cd the right tool for a file?",
    "Is there a command that lists what is actually here?",
    "You used cd, but that walks into folders. What does a file need instead?",
    "The terminal could not find {{target}} where you are standing.",
    "Can you find another way to look inside it?",
    "Would you like to read more about what went wrong?"
  ]
  for (const a of allowed) {
    assert.equal(findRunnableCommand(a), null, `should have been allowed: ${a}`)
  }
})

// D15, mechanised. A hint fires wherever its slot and requires hold, so copy
// that asks the child to name a file has to be paired with the decorator that
// says a file is there.
test("no hint asks for something requires does not guarantee", () => {
  for (const { file, data } of hints) {
    const slot = knownSlots.get(slotKeyOf(data))
    if (!slot) continue
    const problem = findUngroundedAssumption(data.body, {
      hasTarget: slot.has_target, requires: data.requires,
    })
    assert.equal(problem, null, `${file} ${problem}`)
  }
})

test("findUngroundedAssumption separates a claim from a description", () => {
  const noTarget = { hasTarget: false, requires: {} }
  // Describes the command; asserts nothing about the folder.
  assert.equal(findUngroundedAssumption("cat needs a file name.", noTarget), null)
  // Asks them to look around and pick one.
  assert.ok(findUngroundedAssumption("Which file did you want to read?", noTarget))
  assert.ok(findUngroundedAssumption("Which folder did you mean?", noTarget))
  // Grounded by the decorator that makes it true.
  assert.equal(findUngroundedAssumption("Which file did you want to read?",
    { hasTarget: false, requires: { cwd_has_files: true } }), null)
  // With a target, {{target}} names the thing and no claim is made.
  assert.equal(findUngroundedAssumption("Which file did you mean?",
    { hasTarget: true, requires: {} }), null)
})

// The verb-plus-preposition case. "You tried to use cat on {{target}}" is the
// hint referencing the error the child just saw -- which the authoring prompt
// asks for -- and no shell runs `cat on X`. Before this, the rule rejected that
// phrasing on all eight candidates for cat/Is_A_Directory in one run.
test("the No-Do predicate reads a preposition after the verb as prose", () => {
  assert.equal(findRunnableCommand("You tried to use cat on {{target}}, but it is a folder."), null)
  assert.equal(findRunnableCommand("You used cd to get in here."), null)
  // Still caught: a real argument after the verb, preposition or not.
  assert.ok(findRunnableCommand("Try running ls caves to see what is there."))
  assert.ok(findRunnableCommand("Use cd rocks instead."))
  assert.ok(findRunnableCommand("Type cat notes.txt now."))
})

// The mirror of the ungrounded rule: copy leaning on something requires
// promises is FALSE. Every cat/Is_A_Directory candidate in one batch asked what
// was inside a directory it declared empty, and passed every other rule.
test("no hint contradicts its own requires", () => {
  for (const { file, data } of hints) {
    const problem = findContradictedDecorator(data.body, data.requires)
    assert.equal(problem, null, `${file} ${problem}`)
  }
})

test("findContradictedDecorator wants the decorator and the claim together", () => {
  const empty = { target_is_empty_dir: true }
  assert.ok(findContradictedDecorator("Which file inside {{target}} did you want?", empty))
  // Fine without the decorator: the folder may well have something in it.
  assert.equal(findContradictedDecorator("Which file inside {{target}} did you want?", {}), null)
  // Fine with the decorator, as long as the copy does not promise contents.
  assert.equal(findContradictedDecorator("{{target}} is a folder, not a file. What did you want to read?", empty), null)
})
