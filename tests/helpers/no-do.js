// The mechanical copy rules, shared by the template tests and the drafting gate.
//
// It lives here rather than inside a test file because tools/curate/draft.py
// runs the same check on model output before a human ever reads it: giving away
// the answer is the failure a small model produces most, so it has to be caught
// mechanically, and by exactly the same predicate that guards the dictionary.

// ----------------------------------------------------------------- the No-Do rule
//
// "Ask, never instruct": a hint must not contain a runnable command line,
// because the child typing it is the entire lesson (templates/README.md rule 1,
// docs/architecture.md section 2).
//
// The predicate deliberately distinguishes two things:
//   - naming a command in prose            -> allowed  ("cd is for folders")
//   - a verb followed by an argument       -> rejected ("cd .." / "cat notes.txt")
// so the test enforces the rule without banning the vocabulary a hint needs to
// teach with. Prompt markers and code formatting are rejected outright.
//
// A false positive here is the safe direction: it asks a human to look.

// Commands whose names are not also ordinary English words. A bare verb plus
// any argument-shaped token is a command line.
const HARD_VERBS = [
  "cd", "ls", "pwd", "mkdir", "rmdir", "rm", "mv", "cp", "cat", "grep", "chmod"
]

// Commands that double as everyday words -- "could not find x", "touch the
// screen", "read more about it". Flagging these on any argument produces false
// positives on ordinary hint prose, so they need a stronger signal: a flag, or
// a path-shaped argument. `find {{target}}` is prose; `find . -name x` is not.
const SOFT_VERBS = [
  "find", "touch", "more", "less", "head", "tail", "clear", "man", "echo"
]

// Argument shapes. ANY covers a placeholder or a bare word that follows a hard
// verb; PATHY is the narrower set that makes a soft verb unambiguous.
const ANY_ARG = `(-{1,2}\\w|["'./~]|\\{\\{|\\w+\\.\\w|\\.\\.)`
const PATHY_ARG = `(-{1,2}\\w|["'~]|\\.{1,2}/|/\\w|\\w+\\.\\w|\\.{1,2}(?=\\s|$))`

export function findRunnableCommand(body) {
  const text = String(body)

  if (/(^|\s)\$\s+\S/.test(text)) return "shell prompt marker ($)"
  if (text.includes("`")) return "backtick code formatting"

  // A bare word is a perfectly good argument -- "ls caves" is a command line --
  // but "cd walks into folders" is legitimate teaching prose with the same
  // shape. What separates them is presentation: a command being handed over is
  // quoted, or introduced by an instruction verb. Both are checked before the
  // argument-shape rules below, because both are unambiguous.
  const ALL_VERBS = [...HARD_VERBS, ...SOFT_VERBS].join("|")

  const quoted = text.match(new RegExp(`["'\`]\\s*(${ALL_VERBS})\\s+\\S`))
  if (quoted) return `"${quoted[1]}" quoted with an argument`

  // One optional word between the instruction and the command, so "try running
  // ls x" reads the same as "type ls x". Gerunds included; "used cd, but..." is
  // still safe because a trailing comma fails the argument match.
  const instructed = text.match(new RegExp(
    `\\b(?:use|using|type|typing|run|running|enter|entering|try|trying|write|writing|execute|executing)`
    + `\\s+(?:\\w+\\s+)?["'\`]?(${ALL_VERBS})\\s+\\S`, "i"))
  if (instructed) return `"${instructed[1]}" handed over after an instruction to type it`

  for (const verb of HARD_VERBS) {
    if (new RegExp(`(^|[^\\w-])${verb}\\s+${ANY_ARG}`).test(text)) {
      return `"${verb}" followed by an argument`
    }
  }
  for (const verb of SOFT_VERBS) {
    if (new RegExp(`(^|[^\\w-])${verb}\\s+${PATHY_ARG}`).test(text)) {
      return `"${verb}" followed by a path or flag`
    }
  }
  return null
}


// "One question" from tools/curate/prompts/author-slot.md. A hint that states
// a fact instead of asking one has done the child's thinking, which is the same
// failure as No-Do wearing a different coat -- and it is the shape a small model
// falls into most readily, because explaining is easier than asking.
//
// Mechanical only. That the question is a *good* one, and that its explanation
// is true, is what human review is for.
export function asksAQuestion(body) {
  return String(body).includes("?")
}

// A template ships to every world; a scenario's filenames belong to one. Copy
// that names a file literally -- "you typed tresure_map.txt, but the file is
// secret_map.txt" -- reads correctly against the scenario it was drafted from
// and is wrong everywhere else, because the engine substitutes {{target}} and
// nothing else.
//
// This is the failure a model falls into when the drafting input hands it a
// concrete world, which it must, because copy written against no world at all
// describes the error instead of the situation.
//
// Filename-shaped means word.ext with no space around the dot, so ordinary
// sentence punctuation ("a directory. What command...") does not trip it.
export function findLiteralFilename(body) {
  const text = String(body)
  // Blank out placeholders first: {{target}} is the correct way to say this.
  const withoutPlaceholders = text.replace(/\{\{\s*[a-z_]+\s*\}\}/g, " ")
  const m = withoutPlaceholders.match(/\b[\w-]+\.[A-Za-z]{1,5}\b/)
  return m ? m[0] : null
}

// findLiteralFilename only catches names shaped like word.ext, which misses
// every directory -- and quoting the error line back with a concrete directory
// in it ("You saw 'flish: cat: caves: Is a directory'") is the same failure.
// Scenario names are known exactly, so check against them rather than guessing
// at a shape.
//
// A scenario naming a directory after a word hint copy might legitimately use
// will make this fire. That friction is correct: the template would still be
// wrong in a world without that directory.
export function findScenarioName(body, names) {
  const text = String(body).replace(/\{\{\s*[a-z_]+\s*\}\}/g, " ")
  for (const name of names) {
    if (new RegExp(`(^|[^\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(text)) {
      return name
    }
  }
  return null
}

// The drafting input names its decorators -- target_near_sibling,
// target_in_parent, cwd_has_children -- and models translate that vocabulary
// straight into the copy: "try checking siblings or moving up directories".
// That is engineering language describing the matcher, handed to a seven year
// old, and it passes every other rule here.
//
// "directory" is deliberately absent: it is the word the authentic error uses,
// so the child has already read it and the hint should echo it.
export function findJargon(body, words) {
  // The list lives in templates/schema/slots.json so the drafting tool can hand
  // it to the model. A rule the model is never told about produces a whole batch
  // of identical rejections -- which is exactly what happened on the Bad_Usage
  // slots, where the lesson is about arguments and "argument" is on the list.
  // {{target}} is the correct way to name the thing; the bare word is not.
  const text = String(body).replace(/\{\{\s*[a-z_]+\s*\}\}/g, " ")
  for (const word of words) {
    if (new RegExp(`(^|[^\\w-])${word}([^\\w-]|$)`, "i").test(text)) return word
  }
  return null
}

// findUngroundedAssumption catches copy that asks the child to pick something
// the template never says is there.
//
// On a slot with no target -- a bad argument count, an unrecognised verb --
// "which file did you mean?" is a claim: that a file is sitting in the folder
// they are standing in, ready to be named. The status guarantees nothing of the
// sort; it only says the verb was used wrongly. At the root of the Lighthouse,
// which holds two folders and no files, the question has no answer.
//
// This is D15 made mechanical, and it is the first gate rule that checks
// whether copy is *true* rather than whether it is well formed. It was the most
// common reason a human rejected a candidate that passed every other rule.
//
// Only the interrogative form is caught. "cat needs a file name" describes the
// command and is fine; "which file did you want?" asks them to look around.
const ASKS_WHICH_FILE = /\b(which|what)\s+(file|filename|file\s+name)\b/i
const ASKS_WHICH_DIR = /\b(which|what)\s+(folder|directory)\b/i

export function findUngroundedAssumption(body, { hasTarget, requires } = {}) {
  // With a target, {{target}} names the thing and the copy asserts nothing
  // about what else is lying around.
  if (hasTarget) return null
  const text = String(body || "")
  const req = requires || {}
  if (ASKS_WHICH_FILE.test(text) && req.cwd_has_files !== true) {
    return `asks which file, but no "cwd_has_files": true in requires says one is here`
  }
  if (ASKS_WHICH_DIR.test(text) && req.cwd_has_dirs !== true) {
    return `asks which folder, but no "cwd_has_dirs": true in requires says one is here`
  }
  return null
}
