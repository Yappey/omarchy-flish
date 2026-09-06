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

**The ceiling breaks at 26B, and constrained decoding buys more than
well-formedness.** `gemma-4-26b-a4b-qat`, run three ways on the same two slots:

| Run | Score | Time | `requires` on cat/Is_A_Directory |
|---|---|---|---|
| `--structured`, card sampling | **7/7** | 14m20s | correctly omitted, 3 of 3 |
| native, card sampling | 6/7 | **35s** | gratuitous decorator, 3 of 3 |
| native, server defaults (earlier) | 7/7 | ~40s | gratuitous decorator, 3 of 3 |

Two things separate cleanly here. The **14 minutes is entirely constrained
decoding** -- the native path with identical sampling took 35 seconds, so
temperature 1.0 is not the cost. And the **decorator discipline tracks the
endpoint, not the sampling**: both native runs attached `target_is_empty_dir`
to every cat candidate while no body mentioned emptiness, and the structured run
attached it to none.

**Constrained decoding fixes shape, not meaning.** `muse-glimmer` makes the
distinction sharp. Under `--structured` it omitted the optional `requires` on
all three cat candidates, exactly as gemma did -- and still wrote scenario
filenames into three of seven bodies, which is the failure it is worst at.

| Defect | Example | Under a grammar |
|---|---|---|
| **structural** -- whether an optional field appears | gratuitous `target_is_empty_dir` | 1 of 9, against 4 of 9 native |
| **content** -- which words fill a string | `secret_map.txt` instead of `{{target}}` | unaffected |

Counting every `cat/Is_A_Directory` candidate that declared `target_is_empty_dir`
while its body never mentioned emptiness: **1 of 9 under `--structured`, 4 of 9
on the native paths.** Substantially reduced, not eliminated — an earlier draft
of this section said "suppressed", which the pooled numbers do not support.

A JSON schema can say "requires is optional" and that changes what the decoder
does with it. It cannot say "this string must not contain a name from the
scenario". So constrained decoding is worth reaching for against the first kind
and is no help at all against the second -- which is most of what the gate and
the reviewer are for.

That is worth more than it sounds. An unnecessary decorator inflates the
specificity score that decides precedence, and **no gate rule catches it** -- it
is one of the judgement calls left to a reader. Constrained decoding appears to
suppress it, plausibly because an optional field must be actively chosen under a
grammar rather than pattern-matched from the `applicable_decorators` list in the
prompt. Six native candidates across two sampling configurations versus three
structured ones is a small sample, but the direction is consistent.

So the trade is 24x wall time for one extra candidate **and** a quality defect
the gate cannot see. For bulk drafting that is probably worth it; for iterating
on a prompt it is not.

**Every timing taken before 2026-09-06 measured the machine, not the model.**
All eleven runs recorded `flash_attention=False` with a physical batch size of
8192 against llama.cpp's default of 512. On a Strix Halo APU that compute buffer
is GTT-backed and pinned, so the host was starved and the work went to swap.
With flash attention on and the batch at 512, `gemma-4-31b` went from 16m9s for
five candidates to **2m34s for seven** -- about 9x.

Scores are unaffected: flash attention is exact attention, and the gate measures
copy rather than throughput. Wall-clock comparisons between models are not, and
should be redone.

**The two request paths differ in more than the grammar, and the grammar is
not the part that matters.** LM Studio's own API takes `system_prompt` and
`input` as separate fields; `/v1/chat/completions` takes a messages array and
applies the model's chat template. Those were never separated until now.
`qwen3.6-35b-a3b`, same slots, same sampling:

| Path | Score | Time |
|---|---|---|
| native fields | 1/7 | 22s |
| messages + grammar | 5/7 | 7m23s |
| **messages, no grammar** | **5/7** | 8m30s |

The grammar adds nothing on a capable model. The chat template decides whether
the copy asks a question at all: the native path failed four of seven on "no
question mark", the messages path none.

The native path's speed is not free either — it was fast because it was
producing short, unconsidered completions. Engaging with the task takes longer
and is what you want.

**But the right endpoint is per model, not global.** `qwen3.8-27b` reverses
the qwen3.6 result exactly: through the messages endpoint it answers the
authoring prompt with `{"ok": true}`, and through the native fields it produces
real hints.

| Model | native fields | messages |
|---|---|---|
| `qwen3.6-35b-a3b` | 1/7 | **5/7** |
| `qwen3.8-27b` | **3/7** in 46s | degenerate `{"ok": true}` |

So there is no globally better request shape, and `messages` is the default only
because it suits more of the models tried. When a model is producing nothing
usable, change `--endpoint` before touching the prompt: `draft.py` now detects a
reply that parses as JSON but contains neither `match` nor `body`, and says so
rather than letting it land as a schema rejection that reads like bad copy.

`--endpoint` and `--structured` are separate flags now. Messages is the default;
the grammar is worth turning on only for a model that cannot be trusted to emit
JSON, which so far means `phi-4-mini-reasoning` and nothing else.

**Two earlier conclusions do not survive that.**

*Retracted -- "`--structured` costs 24x wall time."* That came from gemma-26b's
14m20s structured against 35s native, both under the bad settings. Re-measured
on `gemma-4-31b` with the settings corrected:

| Path | Score | Time |
|---|---|---|
| `--structured` | 6/7 | 2m34s |
| native | **7/7** | 2m51s |

They cost the same, and native was marginally *slower*. The 24x was swap
pressure landing on constrained decoding, not a property of it. The advice that
followed from it -- "worth it for bulk drafting, not for prompt iteration" --
had no basis.

*Weakened -- "constrained decoding suppresses the structural defect."* On
`gemma-4-31b` neither path produced a gratuitous `target_is_empty_dir`: 0 of 3
both ways. The effect was real within gemma-26b (3 of 3 native against 0 of 3
structured) and absent here, so it is a property of that model rather than of
the endpoint. Worth re-testing on gemma-26b under corrected settings before
anyone relies on it.

**At 4B and under there is a ceiling, and it is not a formatting problem.**
Three models, three architectures (phi3, hybrid Mamba2-Transformer, qwen3), both
paths where the model supports both:

| Model | `--structured` | native, reasoning on |
|---|---|---|
| `phi-4-mini-reasoning` 3B | 0/7 | — (offers no "off") |
| `nemotron-3-nano-4b` 4B | 0/7 | 1/7 |
| `qwen3-4b` 4B | 1/7 | 0/7 |

**2 passed of 34 candidates that returned JSON**, and 25 of the 32 failures were
the same one: the body states instead of asking. Reasoning moves it by at most
one candidate in either direction — better for nemotron, worse for qwen3-4b —
which is noise at this sample size, not a signal.

The consistency across three unrelated architectures is what makes this a size
ceiling rather than a quirk of one model or of the prompt. Explaining is what a
small model does when asked to be helpful, and neither constrained decoding nor
deliberation reaches it.

**`--structured` is verified, and it separates two things the benchmark had
been conflating.** Constrained decoding guarantees well-formed, schema-valid
output; it does nothing for whether the copy is any good. On
`phi-4-mini-reasoning` that was the difference between unusable and usable:
22KB unparseable replies and 300s timeouts became 27 seconds with every reply
valid JSON. On `nemotron-3-nano-4b` it changed the failure mode and not the
score — 0/7 structured against 1/7 native with reasoning on, every rejection
"no question mark" either way. At 4B, explaining instead of asking is a
capability limit, and no amount of grammar constraint reaches it.

Reading the cards paid for itself on timing too: nemotron's reasoning-on run
took minutes per candidate before sampling parameters were applied and under
two minutes for all seven after.

**Prefer `--structured` where it works.** LM Studio exposes an
OpenAI-compatible endpoint alongside its own API and supports
`response_format: json_schema` there, so the decoder can be constrained to
`hint.schema.json` directly. A model cannot answer in prose if the grammar will
not let it, which removes the failure that cost this benchmark several
candidates. It is opt-in because the native endpoint is the one exposing the
reasoning control. *Not yet verified against a live model* — it was added after
the last model was unloaded.

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

| Model | Reasoning | Passed | Its characteristic failure |
|---|---|---|---|
| `gemma-4-26b-a4b-qat` | off | 7/7 | a decorator the lesson does not use |
| `gemma-4-31b` | off | 7/7 | points the child at the wrong command |
| `qwen3.8-27b` | off | 5/7 * | prose where JSON belongs |
| `qwen3.6-35b-a3b` | off | 4/7 | scenario filenames in the template |
| `muse-glimmer` | low | 2/7 | scenario names, in five of seven |
| `nemotron-3-nano-4b` | on | 2/7 | explains instead of asking |
| `nemotron-3-nano-4b` | off | 0/7 | explains instead of asking, every time |

Seven attempts each, three on `cat/Is_A_Directory` and four on `ls/Not_Found`,
re-gated under the current rules rather than the rules in force when each ran.

**Three caveats, all worth more than the ranking.**

*Nobody read the model cards until after the benchmark ran.* Doing so changed
how two rows should be read and found a confound under all of them —
`tools/curate/model-profiles.json` records what each card says:

- **`phi-4-mini-reasoning` is out of scope.** Its card states it is "designed
  and tested for math reasoning only". Authoring Socratic copy for children is
  not that, so its result says nothing about hint quality. The tool now warns
  before drafting with it.
- **`muse-glimmer` is an agentic model**, tuned for local agent workflows and
  tool use rather than constrained prose. That is a plausible reading of why
  five of seven candidates quoted scenario names verbatim: agentic tuning
  rewards grounding in the concrete input, and this task wants the opposite.
- **Every model ran on LM Studio's defaults, which match no card.** Gemma 4
  asks for temperature 1.0 and warns the family behaves oddly when it is
  lowered; Qwen3.6 asks for 0.7 with `presence_penalty` 1.5; Nemotron 3 for
  0.6. The tool sent none of these, so the benchmark was partly measuring the
  defaults. It now applies per-model settings, which means **these scores are
  not reproducible against the current tool** — re-run before trusting them.



*The gate moved under the models.* `muse-glimmer` scored 3/3 on the cat slot when
it ran and 1/3 an hour later, because it exposed the rule that then caught it.
Every score here is "against this gate", and the gate got stricter five times
during the benchmark. Re-gate saved candidates rather than trusting a number
from an older run.

*The starred row is contaminated.* `qwen3.8-27b`'s reasoning-on re-run
overwrote part of its reasoning-off run before filenames carried the setting, so
that row mixes two configurations. It is reported rather than quietly dropped;
re-run it if the number matters.

Deliberation is what gets a 4B model to ask a question instead of stating a
fact; on the larger models it is pure latency.

**Every model added to this comparison has exposed a gap, and most of the gaps
were in the tooling rather than in the dictionary.** That is the argument for
running a new model against a slot you have already covered:

- `nemotron` — explaining instead of asking → the question-mark rule.
- `qwen3.6` — scenario filenames in the body → the literal-filename rule.
- `qwen3.8` — a generation that overran the timeout aborted the whole slot →
  timeouts are now skipped, not fatal.
- `muse-glimmer` — 400s on `reasoning: "off"`, which it does not support →
  the setting is negotiated per model now; and it quoted directory names the
  filename rule could not see → the scenario-name rule.

Half the *copy* failures turned out mechanical. That is the argument for running a
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

`qwen3.8-27b` added a fifth failure and the most interesting one. Two of its
four `ls/Not_Found` replies contained no JSON at all: one answered the task in
prose, and the other opened *"Let me work through this carefully"* and reasoned
in the message body. With `reasoning: off` it deliberates anyway, just in the
answer channel instead of the reasoning one — so **off is not universally right,
and for a model that thinks inline it can be actively wrong**, the mirror of the
nemotron result. Check both settings for any new model rather than inheriting
the default.

Turning reasoning back **on** for it does fix the contract adherence — the first
candidate came back as valid JSON, passed the gate, and used `{{target}}`
correctly where the off-run had answered in prose. It also took about seven
minutes for that one candidate, and the second **exceeded the 300s per-generation
timeout**. So the setting that fixes its output is the same one that makes the
model impractical for bulk drafting on a dense 27B; the fix and the cost arrive
together.

That run also exposed a real bug: a timeout used to abort the whole slot. One
slow candidate must not take the batch with it, least of all under `--all`
where the run is long and unattended, so a timeout is now skipped rather than
fatal and `--timeout` is adjustable. A genuinely unreachable server still stops
the slot, because retrying into a dead socket is pointless.

It also made the best decorator judgement so far. Two of its three
`cat/Is_A_Directory` candidates declared `target_is_empty_dir` *and* leaned on
it in the copy ("Since it is empty...", "see what's inside an empty folder").
That is the decorator earning its place, which is what the gemma 26B failed to
do while declaring the same field.

**Where that leaves model choice.** `qwen3.6-35b-a3b` looks like the best
default: MoE, so it is fast; the strongest `cat/Is_A_Directory` judgement of any
model tried; and its one failure class — scenario filenames — is now caught by
the gate rather than by a reader. `gemma-4-26b-a4b-qat` is the throughput
option, at the cost of a decorator defect that only a person will catch. Neither
7/7 model is the obvious pick, which is the point.

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
