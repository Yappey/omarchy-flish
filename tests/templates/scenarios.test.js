// Scenarios are the worlds a child lands in -- and the fixtures a hint's
// decorators are tested against. A hint requiring target_in_parent is only
// reachable in a scenario that has such a shape, so these two artifacts are
// authored together.

import test from "node:test"
import assert from "node:assert/strict"
import Ajv from "ajv/dist/2020.js"
import { scenarios, scenarioSchema, slots } from "../helpers/dictionary.js"
import { buildWorld, everyCwd, decoratorsFor } from "../helpers/matcher.js"

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
// Which decorators the shipped worlds can actually exercise, in BOTH
// directions. A decorator that is never false discriminates nothing; one that is
// never true is a lesson no child can reach, and the hints leaning on it are
// dead weight the Odin side will never see fire.
//
// This used to hand-list five of the eleven and assert that the manifest was
// non-empty, so it could not fail. It now enumerates slots.decorators, which
// means adding a decorator without a world to exercise it fails here.
test("every world decorator is reachable, true and false", (t) => {
  // argv_count is a property of what was typed, not of the world; no scenario
  // can make it unreachable and none should be asked to.
  const NOT_A_WORLD_FACT = new Set(["argv_count"])
  const names = Object.keys(slots.decorators).filter((n) => !NOT_A_WORLD_FACT.has(n))
  const seen = Object.fromEntries(names.map((n) => [n, new Set()]))

  for (const { data } of scenarios) {
    const world = buildWorld(data)
    for (const dir of everyCwd(world)) {
      const here = { root: world.root, cwd: dir }
      // What a child could plausibly type from here: nothing, a real name, a
      // near miss of one, something from upstairs, and pure nonsense.
      const probes = [[], ["zzz-nowhere"]]
      for (const child of dir.children) {
        probes.push([child.name])
        probes.push([child.name.slice(0, -1) + "q"])
      }
      for (const up of dir.parent?.children || []) probes.push([up.name])

      for (const argv of probes) {
        const actual = decoratorsFor(here, argv)
        for (const name of names) seen[name].add(actual[name])
      }
    }
  }

  const missing = []
  for (const name of names) {
    for (const polarity of [true, false]) {
      if (!seen[name].has(polarity)) missing.push(`${name}=${polarity}`)
    }
    t.diagnostic(`  ${seen[name].has(true) ? "x" : " "}${seen[name].has(false) ? "x" : " "} ${name}`)
  }
  assert.deepEqual(missing, [],
    `no scenario exercises: ${missing.join(", ")} -- add a world shaped to, or ` +
    `drop the decorator`)
})
