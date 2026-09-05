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

// {{target}} renders empty unless the match/requires block guarantees there is
// a target to substitute, which would ship a hint with a hole in the sentence.
test("{{target}} is only used when the template establishes a target", () => {
  for (const { file, data } of hints) {
    if (!String(data.body).includes("{{target}}")) continue
    const requires = data.requires || {}
    const establishesTarget =
      Object.prototype.hasOwnProperty.call(requires, "target_exists") ||
      Object.prototype.hasOwnProperty.call(requires, "target_is_file")
    assert.ok(establishesTarget,
      `${file} interpolates {{target}} but declares no requires.target_* decorator`)
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

// ----------------------------------------------------------------- the No-Do rule
//
// "Ask, never instruct": a hint must not contain a runnable command line,
// because the child typing it is the entire lesson (templates/README.md rule 1,
// docs/architecture.md section 2).
//
// The predicate deliberately distinguishes two things:
//   - naming a command in prose            -> allowed  ("cd is for folders")
//   - a verb followed by an argument       -> rejected ("cd .." / "cat notes.txt")
// so the test enforces the rule without banning the vocabulary a hint needs to
// teach with. Prompt markers and code formatting are rejected outright.
//
// A false positive here is the safe direction: it asks a human to look.

// Commands whose names are not also ordinary English words. A bare verb plus
// any argument-shaped token is a command line.
const HARD_VERBS = [
  "cd", "ls", "pwd", "mkdir", "rmdir", "rm", "mv", "cp", "cat", "grep", "chmod"
]

// Commands that double as everyday words -- "could not find x", "touch the
// screen", "read more about it". Flagging these on any argument produces false
// positives on ordinary hint prose, so they need a stronger signal: a flag, or
// a path-shaped argument. `find {{target}}` is prose; `find . -name x` is not.
const SOFT_VERBS = [
  "find", "touch", "more", "less", "head", "tail", "clear", "man", "echo"
]

// Argument shapes. ANY covers a placeholder or a bare word that follows a hard
// verb; PATHY is the narrower set that makes a soft verb unambiguous.
const ANY_ARG = `(-{1,2}\\w|["'./~]|\\{\\{|\\w+\\.\\w|\\.\\.)`
const PATHY_ARG = `(-{1,2}\\w|["'~]|\\.{1,2}/|/\\w|\\w+\\.\\w|\\.{1,2}(?=\\s|$))`

export function findRunnableCommand(body) {
  const text = String(body)

  if (/(^|\s)\$\s+\S/.test(text)) return "shell prompt marker ($)"
  if (text.includes("`")) return "backtick code formatting"

  for (const verb of HARD_VERBS) {
    if (new RegExp(`(^|[^\\w-])${verb}\\s+${ANY_ARG}`).test(text)) {
      return `"${verb}" followed by an argument`
    }
  }
  for (const verb of SOFT_VERBS) {
    if (new RegExp(`(^|[^\\w-])${verb}\\s+${PATHY_ARG}`).test(text)) {
      return `"${verb}" followed by a path or flag`
    }
  }
  return null
}

test("no hint body contains a runnable command line (No-Do)", () => {
  for (const { file, data } of hints) {
    const found = findRunnableCommand(data.body)
    assert.equal(found, null,
      `${file} violates No-Do: ${found}\n  body: ${data.body}`)
  }
})

// Guard the guard: if the predicate stops catching these, it is not doing
// anything and the rule quietly stops being enforced.
test("the No-Do predicate catches known violations", () => {
  const violations = [
    "Try cd .. to go back up a level.",
    "Type cat secret_map.txt and see what happens.",
    "Use cd {{target}} instead.",
    "Run `ls` to see the files.",
    "At the prompt: $ ls -la",
    "You could use ls -l here.",
    "find . -name secret_map.txt",
    "touch ./notes.txt"
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
