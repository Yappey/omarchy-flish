// Pure protocol and presentation logic for the Flish tutor.
//
// Extracted from Service.qml and HintPanel.qml so it can be tested without a
// Quickshell process: QML types cannot be loaded outside the Quickshell binary,
// so anything left inside a .qml file is only reachable through a running
// shell. This follows the same split omarchy-shell uses for its own plugins
// (NotificationLogic.js, OsdModel.js, ReminderFlowModel.js).
//
// Everything here must stay pure: no QML types, no imports, no I/O, no Date.now
// or new Date() -- callers pass timestamps in. That is what keeps it loadable
// by both QML and a plain JS test runner.
//
// See ../docs/ipc-protocol.md. Tests live in ../tests/tutor/.

// The protocol major this build speaks.
var PROTOCOL_VERSION = 1

// Used when a hint omits ttl_ms entirely. A ttl_ms of 0 is NOT this: zero means
// "stay until dismissed" and must survive as zero.
var DEFAULT_TTL_MS = 12000

var VALID_VERDICTS = ["helpful", "confusing"]

// Decide what to do with one NDJSON line from an engine.
//
// Returns { action, reason, message }, where action is one of:
//   "hint"    -- show message as a hint
//   "dismiss" -- caller checks the id against what is on screen
//   "ignore"  -- drop it; `reason` says why, for logging
//
// Unknown types and unknown protocol versions are ignored rather than treated
// as errors: that is the forward-compatibility hinge for v1.x, so a newer
// engine talking to an older tutor degrades instead of breaking.
function classifyLine(line) {
  var text = String(line === null || line === undefined ? "" : line).trim()
  if (text === "") return { action: "ignore", reason: "empty", message: null }

  var message
  try {
    message = JSON.parse(text)
  } catch (e) {
    return { action: "ignore", reason: "unparseable", message: null }
  }

  if (message === null || typeof message !== "object" || Array.isArray(message))
    return { action: "ignore", reason: "not-an-object", message: null }

  if (Number(message.v) !== PROTOCOL_VERSION)
    return { action: "ignore", reason: "unsupported-version", message: message }

  if (message.type === "hint") {
    if (hintIdOf(message) === "")
      return { action: "ignore", reason: "hint-without-id", message: message }
    return { action: "hint", reason: "", message: message }
  }

  if (message.type === "dismiss") {
    if (hintIdOf(message) === "")
      return { action: "ignore", reason: "dismiss-without-id", message: message }
    return { action: "dismiss", reason: "", message: message }
  }

  // "hello" lands here too: it is valid, it just needs no action.
  return { action: "ignore", reason: "unhandled-type", message: message }
}

function hintIdOf(message) {
  if (!message) return ""
  return String(message.id === null || message.id === undefined ? "" : message.id)
}

// Only the engine whose hint is on screen may take it down. Without this check
// one terminal resetting would yank the hint another terminal is still showing.
function shouldDismiss(message, currentHintId) {
  var id = hintIdOf(message)
  if (id === "") return false
  if (!currentHintId) return false
  return id === String(currentHintId)
}

function isValidVerdict(verdict) {
  return VALID_VERDICTS.indexOf(String(verdict)) !== -1
}

// ------------------------------------------------------------------ outbound

function ackPayload(hintId) {
  return { v: PROTOCOL_VERSION, type: "ack", id: String(hintId), rendered: true }
}

// `at` is an ISO-8601 string supplied by the caller, so this stays pure and the
// test does not have to freeze the clock.
function feedbackPayload(hintId, verdict, at) {
  return {
    v: PROTOCOL_VERSION,
    type: "feedback",
    id: String(hintId),
    verdict: String(verdict),
    at: String(at)
  }
}

// --------------------------------------------------------------- presentation

// Normalise a hint ttl.
//
// A missing ttl_ms falls back to the default, but an explicit 0 means "stay
// until dismissed" and must come through as 0. `Number(ttl || DEFAULT)` gets
// this wrong, because 0 is falsy -- which silently turns every
// stay-until-dismissed hint into a 12-second one.
function normalizeTtlMs(raw) {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_TTL_MS
  var ttl = Number(raw)
  if (!isFinite(ttl) || ttl < 0) return DEFAULT_TTL_MS
  return Math.floor(ttl)
}

// Turn a summon payload into the fields the card renders. Returns null when the
// payload is unusable, so the panel can decline to open rather than showing an
// empty card.
function hintFromPayload(payloadJson) {
  var payload
  try {
    payload = JSON.parse(payloadJson || "{}")
  } catch (e) {
    return null
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return null

  var id = hintIdOf(payload)
  if (id === "") return null

  return {
    id: id,
    template: String(payload.template === undefined || payload.template === null ? "" : payload.template),
    title: String(payload.title === undefined || payload.title === null ? "" : payload.title),
    body: String(payload.body === undefined || payload.body === null ? "" : payload.body),
    ttlMs: normalizeTtlMs(payload.ttl_ms)
  }
}

// Shown in place of the buttons for a beat after the child taps, so the tap
// visibly lands instead of the card just vanishing.
function acknowledgementText(verdict) {
  return verdict === "helpful"
    ? "Glad that helped."
    : "Thanks -- we will make it clearer."
}
