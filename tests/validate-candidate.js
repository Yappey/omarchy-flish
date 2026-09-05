#!/usr/bin/env node
// Gate one candidate hint template, for tools/curate/draft.py.
//
// Runs the same rules the dictionary tests run -- schema, No-Do, slot validity,
// placeholder safety -- so a model's output is held to exactly the standard a
// committed template is. This is the machine gate that runs before a human ever
// reads a candidate; it exists because giving away the answer is the failure a
// small model produces most often, and catching that by hand does not scale.
//
//   node tests/validate-candidate.js path/to/candidate.json
//   cat candidate.json | node tests/validate-candidate.js -
//
// Exit 0 = worth a human's time. Exit 1 = rejected, reasons on stdout.

import { readFileSync } from "node:fs"
import Ajv from "ajv/dist/2020.js"
import { hintSchema, knownSlots, slotKey, slotKeyOf } from "./helpers/dictionary.js"
import { findRunnableCommand, asksAQuestion, findLiteralFilename } from "./helpers/no-do.js"

const arg = process.argv[2]
if (!arg) {
  console.error("usage: validate-candidate.js <file.json|->")
  process.exit(2)
}

let raw
try {
  raw = readFileSync(arg === "-" ? 0 : arg, "utf8")
} catch (e) {
  console.log(`unreadable: ${e.message}`)
  process.exit(1)
}

let candidate
try {
  candidate = JSON.parse(raw)
} catch (e) {
  console.log(`not JSON: ${e.message}`)
  process.exit(1)
}

const problems = []

const validate = new Ajv({ allErrors: true, strict: false }).compile(hintSchema)
if (!validate(candidate)) {
  for (const e of validate.errors) {
    problems.push(`schema: ${e.instancePath || "/"} ${e.message}`)
  }
}

const key = slotKeyOf(candidate)
const slot = knownSlots.get(key)
if (!slot) {
  problems.push(`slot ${key} is not one the engine can produce (see templates/schema/slots.json)`)
} else {
  for (const name of Object.keys(candidate.requires || {})) {
    if (!slot.applicable_decorators.includes(name)) {
      problems.push(
        `decorator "${name}" does not discriminate on ${key}` +
        ` (allowed: ${slot.applicable_decorators.join(", ") || "none"})`)
    }
  }
  if (String(candidate.body || "").includes("{{target}}") && !slot.has_target) {
    problems.push(`{{target}} would render empty on ${key}`)
  }
}

if (!asksAQuestion(candidate.body || "")) {
  problems.push("body states rather than asks: no question mark")
}

const literal = findLiteralFilename(candidate.body || "")
if (literal) {
  problems.push(
    `body names the file "${literal}" literally; use {{target}} so the hint ` +
    `works in every scenario`)
}

const runnable = findRunnableCommand(candidate.body || "")
if (runnable) problems.push(`No-Do: body contains ${runnable}`)

const titleRunnable = findRunnableCommand(candidate.title || "")
if (titleRunnable) problems.push(`No-Do: title contains ${titleRunnable}`)

for (const m of String(candidate.body || "").matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
  if (m[1] !== "target") problems.push(`unknown placeholder {{${m[1]}}}`)
}

if (problems.length) {
  for (const p of problems) console.log(p)
  process.exit(1)
}
console.log("ok")
