// Scenarios are the worlds a child lands in -- and the fixtures a hint's
// decorators are tested against. A hint requiring target_in_parent is only
// reachable in a scenario that has such a shape, so these two artifacts are
// authored together.

import test from "node:test"
import assert from "node:assert/strict"
import Ajv from "ajv/dist/2020.js"
import { scenarios, scenarioSchema, slots } from "../helpers/dictionary.js"

const walk = (entries, path = "", out = []) => {
  for (const e of entries || []) {
    const full = `${path}/${e.name}`
    out.push({ ...e, path: full })
    if (e.kind === "dir") walk(e.entries, full, out)
  }
  return out
}

test("there is at least one scenario", () => {
  assert.ok(scenarios.length > 0, "no scenarios found in templates/scenarios/")
})

test("every scenario validates against scenario.schema.json", () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(scenarioSchema)
  for (const { file, data } of scenarios) {
    if (!validate(data)) {
      assert.fail(`${file}:\n` + validate.errors
        .map((e) => `  ${e.instancePath || "/"} ${e.message}`).join("\n"))
    }
  }
})

test("scenario id matches its filename", () => {
  for (const { file, id, data } of scenarios) {
    assert.equal(data.id, id, `${file} declares id "${data.id}"`)
  }
})

// vfs.find_child returns the first match, so two entries sharing a name in one
// directory makes the second unreachable.
test("names are unique within a directory", () => {
  for (const { file, data } of scenarios) {
    const check = (entries, path) => {
      const seen = new Set()
      for (const e of entries || []) {
        assert.ok(!seen.has(e.name), `${file}: "${e.name}" appears twice in ${path || "/"}`)
        seen.add(e.name)
        if (e.kind === "dir") check(e.entries, `${path}/${e.name}`)
      }
    }
    check(data.entries, "")
  }
})

// vfs.load_scenario refuses a world whose cwd does not resolve, and the engine
// then exits. Catching it here means it never ships.
test("cwd resolves to a directory in the tree", () => {
  for (const { file, data } of scenarios) {
    if (data.cwd === "/") continue
    const node = walk(data.entries).find((e) => e.path === data.cwd)
    assert.ok(node, `${file}: cwd "${data.cwd}" does not exist in the tree`)
    assert.equal(node.kind, "dir", `${file}: cwd "${data.cwd}" is a file`)
  }
})

test("files have content and directories do not", () => {
  for (const { file, data } of scenarios) {
    for (const e of walk(data.entries)) {
      if (e.kind === "file") {
        assert.ok(!("entries" in e), `${file}: file ${e.path} has entries`)
      } else {
        assert.ok(!("content" in e), `${file}: directory ${e.path} has content`)
      }
    }
  }
})

// Not a failure -- it is a worklist. A decorator no scenario can exercise is a
// hint that can be authored but never fires, and never tested.
test("decorator reachability report", (t) => {
  const all = walk(scenarios.flatMap((s) => s.data.entries))
  const dirs = all.filter((e) => e.kind === "dir")

  const reachable = {
    cwd_has_children: dirs.some((d) => (d.entries || []).length > 0),
    target_is_empty_dir: dirs.some((d) => (d.entries || []).length === 0),
    target_is_file: all.some((e) => e.kind === "file"),
    cwd_is_root: scenarios.some((s) => s.data.cwd === "/"),
    target_in_parent: dirs.some((d) => {
      const childNames = new Set((d.entries || []).map((e) => e.name))
      return (d.entries || []).some((c) =>
        c.kind === "dir" && (c.entries || []).every((g) => !childNames.has(g.name)) &&
        childNames.size > 0)
    })
  }
  for (const [name, ok] of Object.entries(reachable)) {
    t.diagnostic(`  ${ok ? "x" : " "} ${name}`)
  }
  const unreachable = Object.entries(reachable).filter(([, ok]) => !ok).map(([n]) => n)
  if (unreachable.length) {
    t.diagnostic(`  no scenario currently exercises: ${unreachable.join(", ")}`)
  }
  assert.ok(Object.keys(slots.decorators).length > 0)
})
