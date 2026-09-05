// Guards slots.json against the engine drifting away from it.
//
// slots.json is hand-maintained: it is the authoring worklist and the input to
// the drafting pipeline, so it has to be readable and annotated. That makes it
// exactly the kind of file that silently goes stale. This parses
// engine/src/commands/commands.odin and asserts the two agree, so adding a
// command without declaring its failures is a test failure rather than a
// dictionary that quietly cannot cover it.
//
// The parse is deliberately literal. If it breaks on a refactor, that is the
// test asking to be looked at, not something to route around.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { repo, slots, slotKey } from "../helpers/dictionary.js"

const source = readFileSync(resolve(repo, "engine/src/commands/commands.odin"), "utf8")

function declaredStatuses() {
  const block = source.match(/Status :: enum \{([\s\S]*?)\}/)
  assert.ok(block, "could not find the Status enum")
  return block[1].split("\n").map((l) => l.trim().replace(/,$/, "")).filter(Boolean)
}

// verb -> the cmd_* proc the dispatch switch routes it to.
function dispatchTable() {
  const block = source.match(/switch argv\[0\] \{([\s\S]*?)\n\t\}/)
  assert.ok(block, "could not find the dispatch switch")
  const table = new Map()
  for (const m of block[1].matchAll(/case "(\w+)":\s*\n\s*return (cmd_\w+)\(/g)) {
    table.set(m[1], m[2])
  }
  return table
}

// The statuses each cmd_* proc can assign, excluding Ok.
function statusesByProc() {
  const out = new Map()
  const procs = [...source.matchAll(/^(cmd_\w+) :: proc[\s\S]*?(?=\n@\(private\)|\n\/\/ ---|\Z)/gm)]
  for (const p of procs) {
    const found = new Set()
    for (const m of p[0].matchAll(/outcome\.status = \.(\w+)/g)) {
      if (m[1] !== "Ok") found.add(m[1])
    }
    out.set(p[1], found)
  }
  return out
}

test("slots.json declares exactly the failures the engine can produce", () => {
  const dispatch = dispatchTable()
  const byProc = statusesByProc()

  const fromEngine = new Set()
  for (const [verb, proc] of dispatch) {
    const statuses = byProc.get(proc)
    assert.ok(statuses, `dispatch routes "${verb}" to ${proc}, which was not parsed`)
    for (const status of statuses) fromEngine.add(slotKey(verb, status))
  }

  // The default arm of the dispatch: any unrecognised verb.
  assert.match(source, /case:\s*\n\s*outcome\.status = \.Unknown_Command/,
    "expected the dispatch default arm to set Unknown_Command")
  fromEngine.add(slotKey("", "Unknown_Command"))

  const fromManifest = new Set(slots.slots.map((s) => slotKey(s.command, s.status)))

  const missing = [...fromEngine].filter((k) => !fromManifest.has(k)).sort()
  const extra = [...fromManifest].filter((k) => !fromEngine.has(k)).sort()

  assert.deepEqual(missing, [],
    `the engine can produce these, but slots.json does not declare them: ${missing.join(", ")}`)
  assert.deepEqual(extra, [],
    `slots.json declares these, but the engine cannot produce them: ${extra.join(", ")}`)
})

test("every status in slots.json is a real engine status", () => {
  const valid = declaredStatuses()
  for (const slot of slots.slots) {
    assert.ok(valid.includes(slot.status),
      `slots.json uses "${slot.status}", not in the Status enum (${valid.join(", ")})`)
  }
})

// Authoring a hint for a status nothing assigns is wasted work, and it is how
// Permission_Denied sat in the enum unreachable for the whole project so far.
test("no status is declared but unreachable", () => {
  const assigned = new Set(["Ok"])
  for (const m of source.matchAll(/outcome\.status = \.(\w+)/g)) assigned.add(m[1])
  const orphans = declaredStatuses().filter((s) => !assigned.has(s))
  assert.deepEqual(orphans, [],
    `these statuses are declared but never assigned: ${orphans.join(", ")}`)
})
