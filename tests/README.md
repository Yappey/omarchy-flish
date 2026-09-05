# Tests

Three layers, split by what infrastructure each one needs.

| Layer | Location | Needs | In CI |
|---|---|---|---|
| Hint dictionary | `templates/` | Node | yes |
| Slot coverage + engine drift | `templates/` | Node | yes |
| Scenarios | `templates/` | Node | yes |
| Tutor protocol logic | `tutor/` | Node | yes |
| Tutor end-to-end | `../scripts/e2e-tutor.py` | live Omarchy session | no |
| Engine unit tests | `../engine/tests/` | Odin | when Odin is installed |

## Running the automated tests

```bash
cd tests
npm install        # once: ajv, 5 packages
npm test           # everything, ~70ms
npm run test:templates
npm run test:tutor
node --test tutor/protocol.test.js         # one file
node --test --test-name-pattern "No-Do"    # one test
```

Two of the tests print reports rather than asserting: `coverage report` lists the
slots still needing hints, and `decorator reachability report` lists decorators
no scenario can currently exercise. Both are worklists, and both are meant to be
read in the test output rather than chased down separately.

The gate that gets used outside the suite:

```bash
node tests/validate-candidate.js path/to/candidate.json   # exit 0 = worth reading
```

Engine tests are separate and need the Odin compiler:

```bash
engine/scripts/test.sh
```

## What each layer covers

### `templates/` — the hint dictionary

Pure data, no compiler and no desktop. Validates every `templates/hints/*.json`
against `templates/schema/hint.schema.json` (ajv, draft 2020-12 build — the
default ajv export is draft-07 and will not load this schema), plus the rules
the schema cannot express: ids unique, id matches filename, `{{target}}` only
used where a `requires.target_*` decorator guarantees something to substitute.

The interesting one is **No-Do**, the rule that a hint asks and never instructs
(`templates/README.md` rule 1). The predicate splits commands into two tiers,
because the naive version has false positives on ordinary hint prose:

- **Hard verbs** (`cd`, `ls`, `cat`, `rm`, …) — names that are not also English
  words. Verb + any argument-shaped token is a command line.
- **Soft verbs** (`find`, `touch`, `more`, `head`, …) — everyday words too.
  These need a stronger signal: a flag or a path. `find {{target}}` is prose;
  `find . -name x` is not.

Naming a command in prose stays legal ("`cd` walks into folders"); giving a
runnable line does not ("`cd ..`"). Two tests guard the predicate itself — one
asserting known violations are caught, one asserting Socratic prose is not — so
it cannot rot into a no-op. **A false positive is the safe direction:** it asks
a human to look at the copy.

### `templates/` — slots and scenarios

A **slot** is one `(command, status)` pair: what `session.signature_of` keys
strikes on, and therefore the unit that can earn a hint. `slots.json` enumerates
every slot the engine can produce, and `slots.test.js` asserts the dictionary
stays honest about it — no template for a slot the engine cannot produce, no
decorator that the slot's status already implies (those discriminate nothing and
only inflate the specificity score that decides precedence), and no two templates
that tie on specificity while both matching the same failure.

`slot-drift.test.js` parses `engine/src/commands/commands.odin` and fails when it
disagrees with `slots.json`, so adding a command without declaring its failures
breaks the build rather than silently leaving it uncoverable. It also fails on a
status that is declared but never assigned — which is how the dead
`Permission_Denied` was found.

`scenarios.test.js` validates the worlds. Scenarios are hint fixtures as much as
content: a hint requiring `target_in_parent` can only fire in a world shaped that
way, so the two are authored together.

### `tutor/` — protocol logic

QML types cannot load outside the Quickshell binary (`qmltestrunner` fails with
`plugin "quickshell-coreplugin" not found`), so anything left inside a `.qml`
file is only reachable through a running shell. The pure logic therefore lives
in `tutor/TutorProtocol.js` — the same split omarchy-shell uses for its own
plugins (`NotificationLogic.js`, `OsdModel.js`).

`helpers/load-qml-js.js` loads that file by wrapping it in an IIFE and reading
back its declarations, so **the `.js` stays byte-identical to what QML imports**
— no `module.exports` scaffolding in shipped code.

Covered: line classification and routing, forward compatibility (unknown types
and future `v` are ignored, never errors), dismiss id-scoping, ttl
normalisation, payload shapes.

`fixtures/protocol/inbound.json` is a golden set of wire lines with their
expected classification. It is deliberately language-neutral so the engine side
can be tested against the same bytes once its socket client exists — that is
what keeps the two halves of the seam from drifting.

## Drafting hints with a local model

`tools/curate/draft.py` iterates uncovered slots and drafts candidates against an
LM Studio server (default `http://127.0.0.1:1234`, override with
`FLISH_LMSTUDIO`).

```bash
tools/curate/draft.py --list                          # the worklist
tools/curate/draft.py --slot cat/Not_Found --show-input   # what the model sees
tools/curate/draft.py --model <key> --slot cat/Not_Found -n 5
```

Every candidate goes through `validate-candidate.js` before it is written, and
rejects are kept next to their reason. Survivors land in
`tools/curate/candidates/` (gitignored) and reach `templates/hints/` only when a
person moves one there.

**Load the model you want before running this.** `draft.py` refuses to draft
with a model LM Studio has not already loaded, because asking for an unloaded
one can trigger a just-in-time load — and this tool loops, over candidates and
(with `--all`) over every uncovered slot. An unattended run on a machine with
JIT enabled could pull several multi-gigabyte models into memory. `--models`
shows what is loaded; `--allow-jit` opts back in if the box can spare it.

**Which model, and whether it deliberates, is measurable — so measure it.**
Candidate filenames carry the model, and each run writes
`<model>.config.json` next to them, because pass rates are not comparable
across different context lengths or offload settings and those are set in the
LM Studio UI rather than here. Seven candidates each, on `cat/Is_A_Directory`
and `ls/Not_Found`:

| Model | Reasoning | Passed | What it got wrong |
|---|---|---|---|
| `gemma-4-26b-a4b-qat` | off | 7/7 | attached a decorator the lesson does not use |
| `gemma-4-31b` | off | 7/7 | pointed the child at the wrong command |
| `qwen3.6-35b-a3b` | off | 4/7 | wrote scenario filenames into the template |
| `nemotron-3-nano-4b` | on | 2/7 | explained instead of asking |
| `nemotron-3-nano-4b` | off | 0/7 | explained instead of asking, every time |

Deliberation is what gets a 4B model to ask a question instead of stating a
fact; on the larger models it is pure latency.

**Every model added to this comparison has exposed a different failure, and
half of them turned out to be mechanical.** That is the argument for running a
new model against a slot you have already covered rather than only against
uncovered ones:

- *Explaining instead of asking* (nemotron) → caught by the question-mark rule.
- *Scenario filenames baked into the body* (qwen) → caught by the
  literal-filename rule. A template ships to every world; a scenario's names
  belong to one, so `"you typed tresure_map.txt, but the file is
  secret_map.txt"` is right in the world it was drafted against and wrong
  everywhere else. This is the failure a model falls into precisely because the
  drafting input hands it a concrete world — which it must, or the copy
  describes the error instead of the situation.
- *A decorator the lesson does not use* (gemma 26B) → **not** mechanical. All
  three of its `cat/Is_A_Directory` candidates required `target_is_empty_dir`
  while no body mentioned emptiness. The lesson holds for any directory, so the
  decorator narrows it wrongly and inflates the specificity score that decides
  precedence.
- *Pointing at the wrong command* (gemma 31B) → **not** mechanical. Two of its
  three bodies asked whether the child needs to walk into the folder, when they
  typed `cat` because they wanted to see inside it. You do not have to enter a
  directory to list it, so the hint teaches a wrong model of the machine.

qwen's surviving `cat/Is_A_Directory` candidates were the best of the three
large models on both judgement axes — correct decorator use *and* pointing at
listing rather than entering — while also producing the only failure class that
the gate could be taught to catch. Pass rate alone would have ranked it last.

**The gate cannot check whether the copy is true, and that is the point of
review.** Nemotron produced a structurally valid hint claiming `cat` reports a
directory *"because there are no files to list"* — wrong. Gemma's output is
markedly better, and still needs a reviewer: one candidate declared
`requires: {"target_is_empty_dir": true}` while its body never mentions
emptiness, so the lesson actually holds for any directory. That is the same
error the coverage test catches in committed templates — an unnecessary
decorator inflates the specificity score and outranks hints that deserve to win
— but in a candidate it is a judgement call, not a rule.

Worth reading every candidate for: is the causal explanation true, is the
question one a child could act on, and does every declared decorator earn its
place?

## Manual checks

Run these on a live session before pushing changes to `tutor/`.

### Automated end-to-end

```bash
scripts/dev-install-tutor.sh
omarchy plugin enable flish.tutor    # first time only
omarchy restart shell
scripts/e2e-tutor.py                 # ~25s; -v echoes the wire
```

It asserts the observable contract over the socket: ack round-trip, feedback
round-trip, dismiss id-scoping across two concurrent engines, unknown-type and
future-version tolerance, disconnect retiring the hint, and `ttl_ms: 0` holding
past the 12-second default.

### What still needs eyes

Nothing above looks at the screen, so these are on you:

1. **Layout.** `scripts/fake-engine.py --long --ttl 0` — the body must wrap
   cleanly, the card must grow to fit, and nothing may clip at the screen edge.
   Compare against `--ttl 0` with the default (short) body.
2. **Click-through.** With a card up, click the desktop *beside* it. The click
   must reach the window underneath. This is the one thing no tool here can
   check: `hyprctl` does not expose input regions and no pointer-injection tool
   is installed. The overlay is a fullscreen surface, so if
   `mask: Region { item: card }` ever breaks, it swallows every desktop click.
3. **Keyboard focus.** With a card up, type into a terminal. Keystrokes must go
   to the terminal — the card is never keyboard focusable.
4. **Theme.** Switch Omarchy themes with a card up; colours must follow.
5. **Readability.** The card is sized for a 7-12 year old. If you change
   `titleSize`/`bodySize` in `HintPanel.qml`, look at it on a real display.

### Debugging

```bash
qs list --all                  # find the shell instance id
qs log -i <id> -t 50           # QML warnings; a plugin that fails to load says so ONLY here
hyprctl layers | grep -A4 flish
omarchy-shell shell call flish.tutor answer helpful    # click a button without a mouse
```

If a change does not appear to take effect, `omarchy restart shell`. Plugin
hot-reload is unreliable — stale QML has survived both a re-copy and
`omarchy-shell shell rescanPlugins`.

## When `templates/` splits out

`tests/templates/` and the `templates` half of `package.json` go with it. The
tutor tests and protocol fixtures stay with `tutor/`. Nothing here imports
across the `engine/` / `tutor/` / `templates/` boundary that
`docs/decisions.md` D5 protects — each test only reads its own component.
