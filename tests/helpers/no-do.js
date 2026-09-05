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
