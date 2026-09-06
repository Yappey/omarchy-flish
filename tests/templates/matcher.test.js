// The reference matcher is only worth having if it is faithful, so these tests
// pin the behaviours where a plausible-looking JavaScript version would quietly
// diverge from engine/src/ -- and one product rule that nothing else checks:
// a template nobody can ever trigger.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildWorld, resolve, editDistance, nearSibling, decoratorsFor, satisfies,
  templatePrecedes, render, evaluate, firingReport, everyCwd, pathOf,
} from "../helpers/matcher.js"
import { scenarios, hints } from "../helpers/dictionary.js"

const WORLD = {
  cwd: "/ship",
  entries: [
    { name: "ship", kind: "dir", entries: [
      { name: "log.txt", kind: "file", content: "day one" },
      { name: "galley", kind: "dir", entries: [] },
      { name: "cabin", kind: "dir", entries: [
        { name: "chart.txt", kind: "file", content: "x" },
      ] },
    ] },
    { name: "dock", kind: "dir", entries: [] },
  ],
}

const world = () => buildWorld(WORLD)

test("buildWorld resolves the starting cwd and links parents", () => {
  const w = world()
  assert.equal(pathOf(w.cwd), "/ship")
  assert.equal(w.cwd.parent, w.root)
  assert.equal(w.cwd.children.length, 3)
})

test("resolve handles absolute, relative, .. and dead ends", () => {
  const w = world()
  assert.equal(resolve(w, w.cwd, "galley").name, "galley")
  assert.equal(resolve(w, w.cwd, "/dock").name, "dock")
  assert.equal(resolve(w, w.cwd, "..").name, "")
  assert.equal(resolve(w, w.cwd, "cabin/chart.txt").name, "chart.txt")
  assert.equal(resolve(w, w.cwd, "nope"), null)
  // A file in a non-final position is a dead end, not a directory to walk on.
  assert.equal(resolve(w, w.cwd, "log.txt/anything"), null)
  // Mirrors vfs.resolve: the empty path is `from` itself.
  assert.equal(resolve(w, w.cwd, ""), w.cwd)
})

test("`..` at the root stays at the root rather than falling off", () => {
  const w = world()
  assert.equal(resolve(w, w.root, "../../.."), w.root)
})

test("edit distance is plain Levenshtein", () => {
  assert.equal(editDistance("", "abc"), 3)
  assert.equal(editDistance("cat", "cat"), 0)
  assert.equal(editDistance("cabin", "cabni"), 2)
  assert.equal(editDistance("log", "dog"), 1)
})

// The threshold is the whole difference between "you almost had it" and "that
// does not exist", which are not the same problem for a seven year old.
test("near sibling allows one edit on short names and two on longer ones", () => {
  const w = world()
  // "log.txt" is 7 characters, so a two-edit miss still counts.
  assert.equal(nearSibling(w.cwd, "lg.tx")?.name, "log.txt")
  // "dock" is 4, so only one edit is allowed: two is a different word.
  const dockWorld = buildWorld({ cwd: "/", entries: [{ name: "dock", kind: "dir" }] })
  assert.equal(nearSibling(dockWorld.cwd, "dcok"), null)
  assert.equal(nearSibling(dockWorld.cwd, "docs")?.name, "dock")
})

test("near sibling ignores an exact match, because that is not a typo", () => {
  const w = world()
  assert.equal(nearSibling(w.cwd, "galley"), null)
})

// The distinction the whole decorator system rests on: with no argument there is
// no target, rather than resolve("") quietly handing back the cwd and making
// target_exists true for a command that named nothing.
test("no argument means no target, not the current directory", () => {
  const w = world()
  const d = decoratorsFor(w, [])
  assert.equal(d.target_exists, false)
  assert.equal(d.argv_count, 0)
  assert.equal(decoratorsFor(w, ["galley"]).target_exists, true)
})

test("decorators read the world the child is standing in", () => {
  const w = world()
  const d = decoratorsFor(w, ["galley"])
  assert.equal(d.cwd_has_files, true)
  assert.equal(d.cwd_has_dirs, true)
  assert.equal(d.cwd_is_root, false)
  assert.equal(d.target_is_empty_dir, true)
  assert.equal(d.target_is_file, false)
})

test("an absent condition is not checked; false is not the same as unspecified", () => {
  const w = world()
  assert.equal(satisfies({}, w, ["galley"]), true)
  assert.equal(satisfies({ cwd_is_root: false }, w, ["galley"]), true)
  assert.equal(satisfies({ cwd_is_root: true }, w, ["galley"]), false)
})

test("precedence is specificity, then min_strike, then id", () => {
  const broad = { id: "b", match: { command: "cd", status: "Not_Found" } }
  const narrow = { id: "a", match: { command: "cd", status: "Not_Found" },
                   requires: { cwd_has_children: true } }
  assert.ok(templatePrecedes(narrow, broad) < 0, "more specific wins")

  const gentle = { id: "z", match: { command: "cd" }, min_strike: 3 }
  const blunt = { id: "a", match: { command: "cd" }, min_strike: 5 }
  assert.ok(templatePrecedes(gentle, blunt) < 0, "lower min_strike goes first")

  const x = { id: "aaa", match: { command: "cd" } }
  const y = { id: "bbb", match: { command: "cd" } }
  assert.ok(templatePrecedes(x, y) < 0, "id is the stable last resort")
})

test("render substitutes both placeholders", () => {
  const w = world()
  const t = { title: "About {{target}}", body: "Did you mean {{near}}?", ttl_ms: 0 }
  const out = render(t, w, ["galleu"])
  assert.equal(out.title, "About galleu")
  assert.equal(out.body, "Did you mean galley?")
  assert.equal(out.ttl_ms, 12000, "0 falls back to the engine default")
})

test("{{near}} renders empty when nothing is close, which is why it needs its decorator", () => {
  const w = world()
  assert.equal(render({ body: "Did you mean {{near}}?" }, w, ["zzzzzz"]).body,
    "Did you mean ?")
})

test("evaluate picks the most specific match and honours min_strike", () => {
  const w = world()
  const dictionary = [
    { id: "broad", match: { command: "cd", status: "Not_Found" },
      title: "t", body: "broad" },
    { id: "narrow", match: { command: "cd", status: "Not_Found" },
      requires: { cwd_has_files: true }, title: "t", body: "narrow" },
    { id: "blunt", match: { command: "cd", status: "Not_Found" },
      min_strike: 5, title: "t", body: "blunt" },
  ]
  const failure = { command: "cd", status: "Not_Found", argv: ["nope"] }
  assert.equal(evaluate(dictionary, w, failure, 3).template, "narrow")
  assert.equal(evaluate(dictionary, w, failure, 3).body, "narrow")
  // Nothing matches a command the dictionary does not cover: no hint is the
  // correct failure mode (D1), not a guessed one.
  assert.equal(evaluate(dictionary, w, { ...failure, command: "ls" }, 3), null)
  // Below every min_strike, nothing has been earned yet.
  assert.equal(evaluate([dictionary[2]], w, failure, 3), null)
  assert.equal(evaluate([dictionary[2]], w, failure, 5).template, "blunt")
})

test("everyCwd walks the whole tree, because a child does", () => {
  const w = world()
  assert.deepEqual(everyCwd(w).map(pathOf).sort(),
    ["/", "/dock", "/ship", "/ship/cabin", "/ship/galley"])
})

// The rule this whole file exists to make checkable. A hint nobody can trigger
// is not a hint; it was invisible until something could evaluate requires
// against a world, and cd-into-file looked dead until reachability considered
// somewhere other than the starting directory.
test("every shipped hint can actually fire in some scenario", () => {
  for (const { file, data } of hints) {
    const report = firingReport(data, scenarios)
    const live = report.filter((r) => r.fires)
    assert.ok(live.length > 0,
      `${file} fires in no scenario: ` +
      report.map((r) => `${r.scenario} (${r.unreachable})`).join("; "))
  }
})
