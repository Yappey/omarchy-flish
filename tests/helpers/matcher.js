// A reference implementation of the engine's hint matcher, in JavaScript.
//
// Why this exists: nothing could answer "does this hint fire, and is it true
// where it fires?" without a running engine, and the engine has never been
// compiled. So the first review pass rejected 26 of 26 candidates by eye, and
// the most common reason was copy that held in the world it was drafted against
// and nowhere else -- exactly the question a matcher answers mechanically.
//
// It has a second job. The Odin side is another developer's, and this is how
// its behaviour gets specified without writing Odin: the fixtures under
// tests/fixtures/matcher/ are generated from here, so they are a conformance
// suite rather than a pile of example data.
//
// This is a MIRROR, not an implementation. Every procedure below has a named
// counterpart in engine/src/. When one changes, the other has to, and the
// fixture diff is what makes that visible -- there is no tooling holding them
// together. Keep the correspondence obvious:
//
//   vfs.odin        resolve, find_child, is_dir, is_empty_dir, is_root,
//                   has_kind, near_sibling, exists_in_parent, edit_distance
//   hints.odin      matches, satisfies, template_precedes, render, evaluate
//
// Deliberately out of scope: session state. There is no already_shown, no
// cooldown, no strike accumulation. A fixture pins one turn's matcher decision,
// which is where the risk sits; sequencing across turns is a separate contract
// and mixing them would make a failure hard to localise.

import { specificity } from "./dictionary.js"

// ------------------------------------------------------------------ the world

// buildWorld turns a scenario document into a tree with parent links, and
// resolves its starting cwd. Mirrors vfs.load_scenario + vfs.build_entries.
export function buildWorld(scenario) {
  const root = { name: "", kind: "dir", children: [], parent: null }
  attach(root, scenario.entries || [])
  const world = { root, cwd: root }
  const cwd = resolve(world, root, scenario.cwd || "/")
  if (!isDir(cwd)) {
    throw new Error(`scenario cwd ${scenario.cwd} is not a directory`)
  }
  world.cwd = cwd
  return world
}

function attach(parent, entries) {
  for (const e of entries) {
    const node = {
      name: e.name,
      kind: e.kind === "dir" ? "dir" : "file",
      content: e.content,
      children: [],
      parent,
    }
    parent.children.push(node)
    if (node.kind === "dir") attach(node, e.entries || [])
  }
}

// resolve walks a path from `from`, or from the root when it is absolute.
// Returns null when a segment is missing or a non-final segment is a file.
// Mirrors vfs.resolve, including "" returning `from` unchanged.
export function resolve(world, from, path) {
  if (path === "") return from
  let current = from
  let rest = path
  if (path.startsWith("/")) {
    current = world.root
    rest = path.slice(1)
  }
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (current.parent) current = current.parent
      continue
    }
    if (current.kind !== "dir") return null
    const child = findChild(current, segment)
    if (!child) return null
    current = child
  }
  return current
}

export const findChild = (dir, name) =>
  isDir(dir) ? dir.children.find((c) => c.name === name) || null : null

const isDir = (node) => !!node && node.kind === "dir"
const isEmptyDir = (node) => isDir(node) && node.children.length === 0
const isRoot = (world, node) => !!node && node === world.root
const hasKind = (dir, kind) => isDir(dir) && dir.children.some((c) => c.kind === kind)

const pathOf = (node) => {
  const parts = []
  for (let n = node; n && n.parent; n = n.parent) parts.unshift(n.name)
  return "/" + parts.join("/")
}
export { pathOf, isDir }

// ------------------------------------------------------------- near siblings

// Plain Levenshtein over bytes. Scenario names are ASCII by schema, so char
// codes and bytes agree; the schema is what keeps that true.
export function editDistance(a, b) {
  const la = a.length, lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  let prev = Array.from({ length: lb + 1 }, (_, j) => j)
  let curr = new Array(lb + 1)
  for (let i = 1; i <= la; i++) {
    curr[0] = i
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[lb]
}

// The closest plausible typo of `name` in `dir`, or null. Distance 1 for names
// of 4 characters or fewer, 2 above -- on a short name, two edits is most of the
// word and stops being a typo. Strictly-closer wins, so on a tie the earlier
// child keeps it, which makes the result depend on scenario entry order exactly
// as the Odin depends on child order.
export function nearSibling(dir, name) {
  if (!isDir(dir) || name === "") return null
  const limit = name.length <= 4 ? 1 : 2
  let best = null
  let bestDistance = limit + 1
  for (const child of dir.children) {
    if (child.name === name) continue
    const distance = editDistance(child.name, name)
    if (distance <= limit && distance < bestDistance) {
      best = child
      bestDistance = distance
    }
  }
  return best
}

const existsInParent = (dir, name) =>
  !!dir && !!dir.parent && name !== "" && !!findChild(dir.parent, name)

// ------------------------------------------------------------------ matching

// Every decorator, computed. Handy for reachability reporting and for showing a
// reviewer why a template did or did not fire, which is otherwise invisible.
export function decoratorsFor(world, argv = []) {
  const name = argv.length > 0 ? argv[0] : ""
  // Mirrors satisfies(): with no argument there is no target at all, rather
  // than resolve("") quietly handing back the cwd.
  const target = argv.length > 0 ? resolve(world, world.cwd, name) : null
  const sibling = nearSibling(world.cwd, name)
  return {
    target_exists: target !== null,
    target_is_file: target !== null && target.kind === "file",
    cwd_has_children: world.cwd.children.length > 0,
    cwd_has_files: hasKind(world.cwd, "file"),
    cwd_has_dirs: hasKind(world.cwd, "dir"),
    target_near_sibling: sibling !== null,
    near_sibling_is_dir: sibling !== null && sibling.kind === "dir",
    target_in_parent: existsInParent(world.cwd, name),
    cwd_is_root: isRoot(world, world.cwd),
    target_is_empty_dir: isEmptyDir(target),
    argv_count: argv.length,
  }
}

// An absent condition is not checked; that is what separates "false" from
// "unspecified" and the whole decorator system rests on it.
export function satisfies(requires, world, argv = []) {
  const actual = decoratorsFor(world, argv)
  for (const [key, want] of Object.entries(requires || {})) {
    if (!(key in actual)) return false
    if (actual[key] !== want) return false
  }
  return true
}

// Mirrors hints.matches. match.stderr is a regex in the schema and a substring
// compare here, matching the engine's own TODO -- see D2.
export function matches(template, failure) {
  const m = template.match || {}
  if (m.command && m.command !== failure.command) return false
  if (m.status && m.status !== failure.status) return false
  if (m.stderr && !String(failure.stderr || "").includes(m.stderr)) return false
  return true
}

export const minStrikeOf = (template) => template.min_strike ?? 3

// Most-specific first, then the gentler min_strike, then id. Never file order:
// with two templates that never collided, at twenty it would, and the winner
// would depend on the filesystem (D11).
export function templatePrecedes(a, b) {
  const sa = specificity(a), sb = specificity(b)
  if (sa !== sb) return sb - sa
  const ma = minStrikeOf(a), mb = minStrikeOf(b)
  if (ma !== mb) return ma - mb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function render(template, world, argv = []) {
  const target = argv.length > 0 ? argv[0] : ""
  const sibling = nearSibling(world.cwd, target)
  const sub = (text) =>
    String(text || "")
      .replaceAll("{{target}}", target)
      .replaceAll("{{near}}", sibling ? sibling.name : "")
  return {
    title: sub(template.title),
    body: sub(template.body),
    ttl_ms: template.ttl_ms > 0 ? template.ttl_ms : 12000,
  }
}

// evaluate returns the hint for one turn, or null. Returning null is the common
// and correct case: an unrecognised failure produces no hint rather than a
// guessed one (D1).
export function evaluate(templates, world, failure, strikes = 3) {
  const sorted = [...templates].sort(templatePrecedes)
  for (const template of sorted) {
    if (strikes < minStrikeOf(template)) continue
    if (!matches(template, failure)) continue
    if (!satisfies(template.requires, world, failure.argv || [])) continue
    return { template: template.id, ...render(template, world, failure.argv || []) }
  }
  return null
}

// --------------------------------------------------------- reviewer's answer

// Every directory in a world, as candidate places to be standing.
//
// A child walks around, so "can this hint ever fire here?" is a question about
// the whole tree and not about `scenario.cwd`. Asking only about the starting
// directory calls cd-into-file dead -- there is no file at / or at /home -- when
// it is perfectly reachable one `cd` later.
export function everyCwd(world) {
  const out = []
  const walk = (node) => {
    if (!isDir(node)) return
    out.push(node)
    for (const child of node.children) walk(child)
  }
  walk(world.root)
  return out
}

// Every place a template fires, with the copy as the child would read it.
// This is judgement question 1 -- "is the explanation true of that world?" --
// turned from a memory exercise into a list.
//
// `unreachable` is a distinct answer from `fires: false`, and the more useful
// one: it means no directory in this world can produce the failure at all, which
// is a fact about the scenario rather than about the template.
export function firingReport(template, scenarios, argv) {
  return scenarios.map(({ id, data }) => {
    const world = buildWorld(data)
    const places = []
    let why = null
    for (const dir of everyCwd(world)) {
      const here = { root: world.root, cwd: dir }
      const probe = argv ? { argv } : probeArgv(template, here)
      if (!probe.argv) {
        why = why || probe.why
        continue
      }
      if (!satisfies(template.requires, here, probe.argv)) continue
      places.push({
        cwd: pathOf(dir),
        argv: probe.argv,
        decorators: decoratorsFor(here, probe.argv),
        ...render(template, here, probe.argv),
      })
    }
    return places.length
      ? { scenario: id, fires: true, start: pathOf(world.cwd), places }
      : { scenario: id, fires: false, start: pathOf(world.cwd), unreachable: why }
  })
}

// What a child would have had to type for this template's failure to happen in
// this world -- or why they could not have.
//
// The status is what fixes the shape of the argument, which is the same reason
// a decorator the status implies is excluded from `requires` (D11): Not_A_Directory
// already means the target is an existing file, so the probe has to find one.
// Picking any old child renders copy that is false about the world and makes the
// report worse than no report.
function probeArgv(template, world) {
  const requires = template.requires || {}
  const status = template.match?.status
  const here = world.cwd.children

  if (status === "Bad_Usage") {
    const n = requires.argv_count ?? 0
    return { argv: here.slice(0, n).map((c) => c.name) }
  }
  if (status === "Unknown_Command") return { argv: [] }

  if (status === "Not_Found") {
    if (requires.target_in_parent === true) {
      const upOnly = (world.cwd.parent?.children || [])
        .filter((c) => !findChild(world.cwd, c.name))
      if (!upOnly.length) return { why: "no name exists in the parent but not here" }
      return { argv: [upOnly[0].name] }
    }
    if (requires.target_near_sibling === true) {
      const wantDir = requires.near_sibling_is_dir
      const pick = here.find((c) =>
        wantDir === undefined ? true : (c.kind === "dir") === wantDir)
      if (!pick) {
        return { why: `nothing here is a ${wantDir ? "folder" : "file"} to misspell` }
      }
      return { argv: [misspell(pick.name)] }
    }
    // A name unlike anything here, so it is a plain miss and not a near one.
    return { argv: ["zzz-nowhere"] }
  }

  const wantFile = status === "Not_A_Directory"
  let pool = here.filter((c) => (c.kind === "file") === wantFile)
  if (status === "Is_A_Directory" && requires.target_is_empty_dir !== undefined) {
    pool = pool.filter((c) => (c.children.length === 0) === requires.target_is_empty_dir)
  }
  if (!pool.length) {
    const what = status === "Is_A_Directory"
      ? (requires.target_is_empty_dir === true ? "empty folder"
        : requires.target_is_empty_dir === false ? "folder with something in it" : "folder")
      : "file"
    return { why: `no ${what} here for ${status}` }
  }
  return { argv: [pool[0].name] }
}

// One transposition: close enough to be a near sibling under either limit,
// without inventing a name that happens to match something else.
function misspell(name) {
  if (name.length < 2) return name + "x"
  const i = Math.max(1, name.length - 2)
  return name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2)
}
