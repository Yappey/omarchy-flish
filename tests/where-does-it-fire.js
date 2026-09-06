#!/usr/bin/env node
// Show where a hint template actually fires, and what a child would read there.
//
// The gate checks whether a candidate is well formed and, since D16, whether one
// kind of claim is grounded. It cannot check the question that rejected 26 of 26
// candidates in the first review pass: is this true of the world it fires in?
// That needed something able to evaluate `requires` against a scenario, which is
// tests/helpers/matcher.js, and this is its command line.
//
//   node tests/where-does-it-fire.js templates/hints/cd-into-file.json
//   node tests/where-does-it-fire.js candidate.json --json
//   cat candidate.json | node tests/where-does-it-fire.js -
//
// Exit 0 = fires somewhere. Exit 1 = fires nowhere, which makes it not a hint.

import { readFileSync } from "node:fs"
import { firingReport } from "./helpers/matcher.js"
import { scenarios } from "./helpers/dictionary.js"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const arg = args.find((a) => a !== "--json")
if (!arg) {
  console.error("usage: where-does-it-fire.js <file.json|-> [--json]")
  process.exit(2)
}

let template
try {
  template = JSON.parse(readFileSync(arg === "-" ? 0 : arg, "utf8"))
} catch (e) {
  console.log(`unreadable: ${e.message}`)
  process.exit(1)
}

const report = firingReport(template, scenarios)

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.some((r) => r.fires) ? 0 : 1)
}

for (const r of report) {
  if (!r.fires) {
    console.log(`  ${r.scenario}: never -- ${r.unreachable || "requires never hold"}`)
    continue
  }
  console.log(`  ${r.scenario}: ${r.places.length} place(s), starts at ${r.start}`)
  // The starting directory first when it is one of them: that is where a child
  // meets this hint soonest, and where wrong copy does the most damage.
  const ordered = [...r.places].sort((a, b) =>
    (a.cwd === r.start ? 0 : 1) - (b.cwd === r.start ? 0 : 1))
  for (const p of ordered.slice(0, 3)) {
    const at = p.cwd === r.start ? `${p.cwd} (start)` : p.cwd
    console.log(`    at ${at}, typing ${JSON.stringify(p.argv)}`)
    console.log(`      ${p.title}`)
    console.log(`      ${p.body}`)
  }
  if (ordered.length > 3) console.log(`    ... and ${ordered.length - 3} more`)
}

if (!report.some((r) => r.fires)) {
  console.log("\nfires in no scenario -- a hint no child can reach is not a hint")
  process.exit(1)
}
