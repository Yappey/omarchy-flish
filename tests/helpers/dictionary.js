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
