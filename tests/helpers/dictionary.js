// Shared loading for the slot manifest, the hint dictionary and the scenarios.

import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve, basename } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
export const repo = resolve(here, "..", "..")

const read = (...p) => JSON.parse(readFileSync(resolve(repo, ...p), "utf8"))

export const slots = read("templates", "schema", "slots.json")
export const hintSchema = read("templates", "schema", "hint.schema.json")
export const scenarioSchema = read("templates", "schema", "scenario.schema.json")

function loadDir(...parts) {
  const dir = resolve(repo, ...parts)
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, id: basename(f, ".json"), data: read(...parts, f) }))
}

export const hints = loadDir("templates", "hints")
export const scenarios = loadDir("templates", "scenarios")

// A slot is one (command, status) pair. An empty command means "any verb",
// which is how the Unknown_Command slot is expressed.
export const slotKey = (command, status) => `${command || "*"}/${status}`

export const slotKeyOf = (template) =>
  slotKey(template.match?.command, template.match?.status)

export const knownSlots = new Map(slots.slots.map((s) => [slotKey(s.command, s.status), s]))

// Mirrors hints.specificity in engine/src/hints/hints.odin. Kept in step by
// intent, not by tooling -- if the Odin changes, change this too.
export function specificity(template) {
  let score = 0
  for (const k of ["command", "status", "stderr"]) if (template.match?.[k]) score += 1
  score += Object.keys(template.requires || {}).length
  return score
}

// Two decorator sets are compatible when no key demands different values --
// i.e. a single world could satisfy both, so both templates could match the
// same failure.
export function decoratorsCompatible(a = {}, b = {}) {
  for (const key of Object.keys(a)) {
    if (key in b && a[key] !== b[key]) return false
  }
  return true
}

// Every name any scenario uses, files and directories alike. A template that
// contains one of these is describing a particular world rather than the
// failure, and will be wrong in every other world.
export const forbiddenWords = slots.forbidden_vocabulary.words

export const scenarioNames = (() => {
  const names = new Set()
  const walk = (entries) => {
    for (const e of entries || []) {
      names.add(e.name)
      if (e.kind === "dir") walk(e.entries)
    }
  }
  for (const s of scenarios) walk(s.data.entries)
  return names
})()

export function coverage() {
  const covered = new Map()
  for (const h of hints) {
    const key = slotKeyOf(h.data)
    if (!covered.has(key)) covered.set(key, [])
    covered.get(key).push(h.id)
  }
  const rows = [...knownSlots.keys()].map((key) => ({
    slot: key,
    templates: covered.get(key) || []
  }))
  return {
    rows,
    uncovered: rows.filter((r) => r.templates.length === 0).map((r) => r.slot),
    orphans: [...covered.keys()].filter((k) => !knownSlots.has(k))
  }
}

// ------------------------------------------------------------- placeholders
//
// What hints.render substitutes, and the condition each one needs to render as
// anything at all. {{target}} is the name the child typed, so it needs a slot
// that has one. {{near}} is the name they almost typed, so it needs a template
// that requires target_near_sibling -- nothing else guarantees such a name
// exists, and a hint that renders a hole is worse than one that never fires.
export const PLACEHOLDERS = new Set(["target", "near"])
export const DEFAULT_MIN_STRIKE = 3

export function placeholderProblems(template, slot) {
  const problems = []
  const body = String(template.body || "")
  for (const m of body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
    if (!PLACEHOLDERS.has(m[1])) problems.push(`unknown placeholder {{${m[1]}}}`)
  }
  if (body.includes("{{target}}") && slot && !slot.has_target) {
    problems.push(
      `{{target}} would render empty on ${slotKey(slot.command, slot.status)}`)
  }
  if (body.includes("{{near}}")) {
    if (template.requires?.target_near_sibling !== true) {
      problems.push(
        `{{near}} needs "target_near_sibling": true in requires; without it the ` +
        `engine has no near name and the sentence renders with a hole in it`)
    }
    // Naming the correction ends the child's thinking, so it is the second
    // hint, not the first: they get a turn to spot it themselves at the default
    // min_strike, and only if that does not land does a blunter template name
    // it. Two templates with the same requires, separated by min_strike, is the
    // shape slots.test.js already sanctions for exactly this.
    if ((template.min_strike ?? DEFAULT_MIN_STRIKE) <= DEFAULT_MIN_STRIKE) {
      problems.push(
        `{{near}} hands over the answer, so it belongs to a blunter second ` +
        `hint: raise min_strike above ${DEFAULT_MIN_STRIKE} and pair it with a ` +
        `template that asks them to spot it first`)
    }
  }
  return problems
}
