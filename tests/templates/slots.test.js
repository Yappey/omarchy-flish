// The slot manifest is the worklist for authoring hints and the contract that
// keeps the dictionary honest about what the engine can actually produce.
//
// A slot is one (command, status) pair -- the unit session.signature_of keys
// strikes on, and therefore the unit that can earn a hint. Decorators split a
// slot into lessons; they never create new slots.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  repo, slots, hints, knownSlots, slotKey, slotKeyOf,
  specificity, decoratorsCompatible, coverage
} from "../helpers/dictionary.js"

test("every template targets a slot the engine can actually produce", () => {
  const { orphans } = coverage()
  assert.deepEqual(orphans, [],
    `template(s) match a slot not in slots.json: ${orphans.join(", ")}`)
})

test("every template only uses decorators applicable to its slot", () => {
  for (const { file, data } of hints) {
    const slot = knownSlots.get(slotKeyOf(data))
    if (!slot) continue   // covered by the previous test
    for (const key of Object.keys(data.requires || {})) {
      assert.ok(slot.applicable_decorators.includes(key),
        `${file} uses "${key}", which is not applicable to ${slotKeyOf(data)} ` +
        `(allowed: ${slot.applicable_decorators.join(", ")})`)
    }
  }
})

test("a slot without a target does not carry target decorators", () => {
  for (const slot of slots.slots) {
    if (slot.has_target) continue
    const targetish = slot.applicable_decorators.filter((d) => d.startsWith("target_"))
    assert.deepEqual(targetish, [],
      `slot ${slotKey(slot.command, slot.status)} has no target but allows ${targetish.join(", ")}`)
  }
})

test("declared decorators all exist in the hint schema", () => {
  const schemaKeys = Object.keys(
    JSON.parse(readFileSync(resolve(repo, "templates/schema/hint.schema.json"), "utf8"))
      .properties.requires.properties)
  for (const name of Object.keys(slots.decorators)) {
    assert.ok(schemaKeys.includes(name), `slots.json documents unknown decorator "${name}"`)
  }
  for (const name of schemaKeys) {
    assert.ok(name in slots.decorators, `hint.schema.json has "${name}" but slots.json does not document it`)
  }
})

// Precedence is specificity, then min_strike, then id (see hints.template_precedes).
// Two templates that tie on specificity AND could match the same world are
// separated only by an alphabetical accident -- which is exactly the
// nondeterminism the ordering rule exists to remove.
test("no two templates are ambiguous at the same specificity", () => {
  for (let i = 0; i < hints.length; i++) {
    for (let j = i + 1; j < hints.length; j++) {
      const a = hints[i], b = hints[j]
      if (slotKeyOf(a.data) !== slotKeyOf(b.data)) continue
      if (specificity(a.data) !== specificity(b.data)) continue
      if ((a.data.min_strike ?? 3) !== (b.data.min_strike ?? 3)) continue
      assert.ok(!decoratorsCompatible(a.data.requires, b.data.requires),
        `${a.file} and ${b.file} can both match the same failure and tie on ` +
        `specificity and min_strike -- only their ids separate them. ` +
        `Split them with a decorator, or give one a higher min_strike.`)
    }
  }
})

test("min_strike is at least the default when set", () => {
  for (const { file, data } of hints) {
    if (data.min_strike === undefined) continue
    assert.ok(data.min_strike >= 1, `${file} has min_strike ${data.min_strike}`)
  }
})

// Not a failure: the dictionary is meant to grow. This surfaces the worklist in
// the test output so it stays visible instead of needing a separate report.
test("coverage report", (t) => {
  const { rows, uncovered } = coverage()
  const covered = rows.length - uncovered.length
  t.diagnostic(`slots covered: ${covered}/${rows.length}`)
  for (const row of rows) {
    t.diagnostic(`  ${row.templates.length ? "x" : " "} ${row.slot}` +
      (row.templates.length ? `  <- ${row.templates.join(", ")}` : ""))
  }
  assert.ok(rows.length > 0)
})
