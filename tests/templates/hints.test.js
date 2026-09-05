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
test("{{target}} is only used on slots that have a target", () => {
  for (const { file, data } of hints) {
    if (!String(data.body).includes("{{target}}")) continue
    const slot = knownSlots.get(slotKeyOf(data))
    assert.ok(slot, `${file} targets an unknown slot`)
    assert.ok(slot.has_target,
      `${file} interpolates {{target}} but ${slotKeyOf(data)} has no target, ` +
      `so it would render empty`)
  }
})

test("no unknown placeholders", () => {
  const KNOWN = new Set(["target"])
  for (const { file, data } of hints) {
    for (const m of String(data.body).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
      assert.ok(KNOWN.has(m[1]), `${file} uses unknown placeholder {{${m[1]}}}`)
    }
  }
})

import { findRunnableCommand, asksAQuestion, findLiteralFilename, findScenarioName, findJargon } from "../helpers/no-do.js"
import { knownSlots, slotKeyOf, scenarioNames } from "../helpers/dictionary.js"

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
    const found = findJargon(data.body)
    assert.equal(found, null, `${file} uses "${found}":\n  ${data.body}`)
  }
})

test("the jargon check keeps the words the error itself uses", () => {
  assert.equal(findJargon("The terminal said Not a directory. What is {{target}}?"), null)
  assert.equal(findJargon("Is the file in another folder?"), null)
  assert.equal(findJargon("Try checking siblings or moving up directories."), "siblings")
  assert.equal(findJargon("If the target you gave is empty, what then?"), "target")
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
