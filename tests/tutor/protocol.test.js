// Tests for tutor/TutorProtocol.js -- the logic extracted out of the tutor's
// QML so it can run without a Quickshell process.
//
// Contract under test: ../../docs/ipc-protocol.md

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { loadQmlJs } from "../helpers/load-qml-js.js"

const P = loadQmlJs("tutor/TutorProtocol.js")
const here = dirname(fileURLToPath(import.meta.url))

const line = (obj) => JSON.stringify(obj)

test("classifyLine routes a well-formed hint", () => {
  const d = P.classifyLine(line({ v: 1, type: "hint", id: "A1", title: "t", body: "b" }))
  assert.equal(d.action, "hint")
  assert.equal(d.message.id, "A1")
})

test("classifyLine routes a dismiss", () => {
  assert.equal(P.classifyLine(line({ v: 1, type: "dismiss", id: "A1" })).action, "dismiss")
})

test("classifyLine ignores hello without treating it as an error", () => {
  const d = P.classifyLine(line({ v: 1, type: "hello", session: "S", pid: 1 }))
  assert.equal(d.action, "ignore")
  assert.equal(d.reason, "unhandled-type")
})

// Forward compatibility is the whole point of the version and type rules: a
// newer engine must degrade against an older tutor, not break it.
test("classifyLine ignores a future protocol version", () => {
  const d = P.classifyLine(line({ v: 2, type: "hint", id: "A1" }))
  assert.equal(d.action, "ignore")
  assert.equal(d.reason, "unsupported-version")
})

test("classifyLine ignores an unknown type", () => {
  assert.equal(P.classifyLine(line({ v: 1, type: "sparkle", id: "A1" })).action, "ignore")
})

test("classifyLine survives junk without throwing", () => {
  for (const junk of ["", "   ", "not json", "{", "null", "[1,2]", "42", '"str"']) {
    const d = P.classifyLine(junk)
    assert.equal(d.action, "ignore", `expected ignore for ${JSON.stringify(junk)}`)
  }
  assert.equal(P.classifyLine(null).action, "ignore")
  assert.equal(P.classifyLine(undefined).action, "ignore")
})

test("classifyLine refuses a hint or dismiss with no id", () => {
  assert.equal(P.classifyLine(line({ v: 1, type: "hint" })).reason, "hint-without-id")
  assert.equal(P.classifyLine(line({ v: 1, type: "dismiss" })).reason, "dismiss-without-id")
})

// Regression: one terminal's dismiss must never take down another terminal's
// hint. This is the defect the two-engine E2E check exists to catch.
test("shouldDismiss only matches the hint currently on screen", () => {
  assert.equal(P.shouldDismiss({ id: "A" }, "A"), true)
  assert.equal(P.shouldDismiss({ id: "A" }, "B"), false)
  assert.equal(P.shouldDismiss({ id: "" }, "B"), false)
  assert.equal(P.shouldDismiss({ id: "A" }, ""), false)
  assert.equal(P.shouldDismiss({ id: "A" }, null), false)
})

// Regression: `Number(ttl || 12000)` turns an explicit 0 into 12000, because 0
// is falsy -- silently converting every stay-until-dismissed hint into a
// 12-second one. The protocol says 0 means "until dismissed".
test("normalizeTtlMs preserves an explicit 0", () => {
  assert.equal(P.normalizeTtlMs(0), 0)
})

test("normalizeTtlMs defaults only when ttl is absent or unusable", () => {
  assert.equal(P.normalizeTtlMs(undefined), 12000)
  assert.equal(P.normalizeTtlMs(null), 12000)
  assert.equal(P.normalizeTtlMs(""), 12000)
  assert.equal(P.normalizeTtlMs("nonsense"), 12000)
  assert.equal(P.normalizeTtlMs(-5), 12000)
  assert.equal(P.normalizeTtlMs(9000), 9000)
  assert.equal(P.normalizeTtlMs("9000"), 9000)
})

test("hintFromPayload keeps ttl_ms 0 intact end to end", () => {
  const hint = P.hintFromPayload(line({ v: 1, type: "hint", id: "A1", title: "t", body: "b", ttl_ms: 0 }))
  assert.equal(hint.ttlMs, 0)
})

test("hintFromPayload returns null rather than opening an empty card", () => {
  assert.equal(P.hintFromPayload("not json"), null)
  assert.equal(P.hintFromPayload("{}"), null)          // no id
  assert.equal(P.hintFromPayload("[1,2]"), null)
  assert.equal(P.hintFromPayload(""), null)
})

test("hintFromPayload coerces missing optional fields to empty strings", () => {
  const hint = P.hintFromPayload(line({ v: 1, type: "hint", id: "A1" }))
  assert.deepEqual(hint, { id: "A1", template: "", title: "", body: "", ttlMs: 12000 })
})

test("outbound payloads match the documented shape", () => {
  assert.deepEqual(P.ackPayload("A1"), { v: 1, type: "ack", id: "A1", rendered: true })
  assert.deepEqual(P.feedbackPayload("A1", "helpful", "2026-09-05T21:00:00Z"),
    { v: 1, type: "feedback", id: "A1", verdict: "helpful", at: "2026-09-05T21:00:00Z" })
})

test("verdicts are limited to the two the overlay offers", () => {
  assert.equal(P.isValidVerdict("helpful"), true)
  assert.equal(P.isValidVerdict("confusing"), true)
  assert.equal(P.isValidVerdict("meh"), false)
})

// The golden fixtures are shared with the engine side, so both halves of the
// seam are tested against the same bytes.
test("golden protocol fixtures classify as recorded", () => {
  const path = resolve(here, "..", "fixtures", "protocol", "inbound.json")
  const cases = JSON.parse(readFileSync(path, "utf8"))
  assert.ok(cases.length > 0, "fixture file is empty")
  for (const c of cases) {
    const d = P.classifyLine(c.line)
    assert.equal(d.action, c.action, `${c.name}: expected action ${c.action}, got ${d.action}`)
    if (c.reason !== undefined) {
      assert.equal(d.reason, c.reason, `${c.name}: expected reason ${c.reason}, got ${d.reason}`)
    }
  }
})
