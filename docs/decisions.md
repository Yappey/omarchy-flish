# Decision log

Newest last. Each entry records what was decided and, more importantly, what it
costs — so a future reader can tell whether the reason still holds.

## D1 — Offline determinism over live LLMs

AI is exclusively a *developer* drafting aid used while writing the offline
template dictionary. The shipped product contains no model.

**Why:** safety (no generated text reaches a child unreviewed), 100 %
determinism (the same error always yields the same hint, which is what makes it
teachable), and zero latency on old hardware.

**Cost:** coverage is bounded by the dictionary. Unmatched failures produce no
hint at all — which is the correct failure mode, but it means dictionary
breadth is the main quality lever.

## D2 — Odin as the engine language

**Why:** tiny compiled footprint, no garbage collector (so no GC pause during
heavy regex parsing — arena allocators give explicit, bounded cost), and native
C ABI compatibility for future embedding.

**Cost:** small ecosystem. There is no mature Odin regex library; the matcher is
either hand-written or bound to a C library (PCRE2). Decide before writing
`engine/src/hints/`.

## D3 — Authentic errors, never hidden

The overlay translates; it does not replace. Real CLI errors are the learning
material.

## D4 — Simulated `SIGINT` on button-mashing

Severe mashing drops the child to a clean prompt to reduce cognitive load while
the hint displays.

**Cost:** needs a mash heuristic that does not misfire on a child who types
slowly and badly. That is a tuning problem, not a design one, and it needs real
telemetry before the thresholds are fixed.

## D5 — Boundary-first monorepo, not three repos yet

The original design called for three repositories from day one. There is one
today.

**Why:** three repos before there is one working vertical slice means three
release processes, three CI configs, and cross-repo PRs for every change that
touches the IPC contract — which, early on, is most of them.

**How the boundary is kept anyway:** `engine/`, `tutor/`, and `templates/` are
top-level and never import from each other by path. They communicate only
through `docs/ipc-protocol.md` and `templates/schema/`. Each is a clean
`git subtree split` when it is time.

**Trigger to split:** when a second UI frontend (GNOME/GTK) starts, or when
`templates/` gets contributors who should not need to build the engine.

## D6 — The tutor listens, the engine connects

Flipped from the original architecture, which implied the engine owns the
socket. The long-lived process (the Quickshell shell) is the server; short-lived
per-terminal engine processes are clients.

**Why:** no per-PID socket discovery, natural multiplexing of several open Flish
terminals, and an engine that starts first simply retries.

See [`ipc-protocol.md`](ipc-protocol.md#who-listens).

## D7 — The tutor is QML, not Lua

Omarchy 4's shell (`omarchy-shell`) is a single long-running Quickshell process,
and Quickshell configs and plugins are written in **QML with JavaScript**.
There is no Lua plugin surface. The original architecture's
"omarchy-flish-tutor (Lua / Quickshell)" is not implementable as written.

## D8 — Plugin id `flish.tutor`

Omarchy's plugin validator reserves the `omarchy.*` id namespace for
first-party plugins and rejects any third-party manifest that claims it
(`omarchy-plugin-validate`). So the plugin id is `flish.tutor`, not
`omarchy.flish-tutor`.

## D9 — "Curation", not "distillation"

The pipeline that turns beta telemetry into shipped hint copy is called
**curation**. The word *distillation* is not used for it anywhere in this
project except to explain why.

**Why:** two reasons, and the second is the one that actually forced the change.

1. *It is inaccurate.* Knowledge distillation means training a student model to
   mimic a teacher's output distribution; the artifact is weights, produced by
   gradient descent. Here a model drafts wording, a person rewrites and approves
   it, and the artifact is a JSON lookup table. There is no student, no training
   step, and nothing derived automatically.

2. *It is legally loaded in exactly the wrong direction.* "Distillation" is the
   term frontier model providers use in the clauses of their terms that prohibit
   training competing models on their outputs. Using a model's output to author
   content that a human reviews is ordinarily permitted; training on it is not.
   Describing our permitted activity with the word reserved for the prohibited
   one invites a misreading that costs us something and buys us nothing.

**The steelman we rejected:** "symbolic distillation" is a real phrase, and a
compact lookup table is arguably a compressed artifact. But the loose metaphor
is not worth the collision, especially in a public repository.

**Cost:** "curation" is a duller word and undersells how much of the coverage
originates from a model. The `tools/curate/` README says so explicitly rather
than letting the name imply the copy was written from scratch.

Renamed with it: `tools/distill/` → `tools/curate/`,
`distill-template.md` → `curate-template.md`.

## D10 — Ask that nothing here be used as training data

`NOTICE.md` asks that neither the repository's data and hint copy nor any
telemetry it produces be used to train models. The source code stays MIT and
unrestricted.

**Scope: any model, any size, any operator.** The ask is not about frontier
labs. It covers a small open-weights model fine-tuned at home exactly as much as
a pretraining run, and the notice leads with that because the home case is the
likely one.

**Why:**

- *The telemetry is children's data.* It records 7–12 year olds being confused
  in private, and it was collected on a narrow promise: a developer reads it to
  write a better hint. Training breaks that promise irreversibly, since a model
  cannot forget. No consent obtainable from a child, or from a parent for a
  child, meaningfully covers permanent inclusion in a model. **This reason is
  model-size-agnostic** — it applies in full to a 7B model on a home GPU.
- *A local fine-tune is the realistic failure mode, not scraping.* Someone
  technical, acting in good faith, trains a small model on their household's
  logs because it never leaves the machine. But small models memorize small
  repetitive corpora unusually well, so a child's real filenames can be
  regurgitated; and adapters get published far more casually than datasets do,
  because they feel like code. At that point the data has left the house inside
  the weights.
- *The hint copy would launder a prohibited use.* It originates partly in
  commercial model output, used under terms that permit authoring and prohibit
  training competitors. Passing it into a training set through this repository
  does indirectly what those terms forbid directly. Stating the asymmetry
  plainly is what keeps it principled rather than hypocritical — see D9.
  **This reason is narrower than the others** and does not apply to local
  models, which is exactly why it must not be the notice's spine.

**Where the line falls.** Not "no model may ever see this data" — that is
unenforceable and gets ignored wholesale. The line is **permanence and reach**:
weights and shared corpora are out; a parent pointing a local model at their own
child's session, transiently, retaining nothing, is their own business. A notice
that forbids a parent from helping their own kid earns no compliance on the
parts that matter.

**What it does not do, and we should not pretend otherwise:** a notice file
stops nobody. It is a statement of intent that makes good-faith compliance
possible and bad-faith use unambiguous.

**What actually protects the data** is structural, and is the part worth
guarding in review:

1. raw telemetry is never committed (`.gitignore`, `git add -f` required);
2. telemetry is local-first with sync off by default and opt-in only;
3. fixtures are redacted *and* the redaction is reviewed before sharing;
4. telemetry is written to `$XDG_STATE_HOME`, not the project directory — a
   training script pointed at a source tree should never find it.

**Cost:** a restriction on the data alongside an MIT code licence is a
two-licence repository, which is mildly awkward to explain and unenforceable in
the way a licence is. Accepted: the alternative is saying nothing, which reads
as consent.

## D11 — Template precedence is specificity, not directory order

The dictionary is sorted at load: most conditions asserted wins, ties broken by
`min_strike` then by id.

**Why:** precedence used to fall out of `os.read_dir` order, because
`evaluate` returns the first match. With two templates that never collided; at
twenty it will, and the winner would depend on the filesystem. That makes "the
same mistake always yields the same hint" — the D1 claim the product rests on —
false in a way nobody would notice until a child got a different hint on a
different machine.

**Why specificity:** a template pinning the command, the status and two
decorators is a narrower claim about the world than one pinning the command
alone, and the narrower claim is the more considered lesson.

**Cost:** specificity is a proxy. A template can now outrank a better one by
declaring a decorator it does not need, which is why a decorator implied by the
status (`target_exists` on a `Not_Found`) is excluded from the slot's
applicable list and rejected by the tests. Both shipped templates were doing
exactly this when the rule went in.

## D12 — Two things the engine deliberately does not model

**`Permission_Denied` is removed.** It sat in the `Status` enum from the start
and nothing ever assigned it. Implementing it means ownership and mode bits on
every node, and "you do not have permission" is a systems-administration
lesson, not a how-files-work one. A locked-chest scenario is a better fit for
7–12 and deserves its own status rather than borrowing POSIX semantics.

**A successful command cannot fire a hint.** `ls secret_map.txt` prints the
filename and exits 0, exactly as real `ls` does, and a comment used to claim
that confusion was a hint trigger. It never could be: hints hang off strikes,
strikes only accumulate on failures, so a success has nothing to attach to.
Adding a parallel trigger would also teach a child to distrust commands that
worked, which costs more than the moment of confusion does.

**Cost:** the `ls`-on-a-file confusion is real and now goes unaddressed. It is a
scenario-design problem — do not put a child in a position where that is their
only move — rather than a hint-dictionary one.

## D13 — A slot manifest, and authoring that starts before telemetry

`templates/schema/slots.json` enumerates every `(command, status)` pair the
engine can produce — the unit `session.signature_of` keys strikes on, and
therefore the unit that can earn a hint. Decorators split a slot into lessons;
they never create new slots.

**Why:** it turns "write some hints" into a finite, checkable queue, and it is
the input the drafting tool iterates over. It also makes coverage a test rather
than a feeling: a template targeting a slot the engine cannot produce now fails
CI, and a status declared but never assigned is caught (which is how the dead
`Permission_Denied` surfaced).

**Why hand-maintained:** it carries the concept and the applicable-decorator
list for each slot, which no parser can derive. A drift test parses
`commands.odin` and fails when the two disagree, so staleness is loud.

**The bootstrap gap it closes:** `curate-template.md` generalises clusters of
beta telemetry, so it cannot run until children have used the product.
`author-slot.md` drafts from a slot plus a scenario instead, which means the
dictionary can be populated first and the whole authoring loop — prompt, model,
machine gate, human review — can be exercised locally with no child data in
existence.

**Cost:** adding a command is now three coordinated edits (the builtin, its
slots, its hints) rather than one. That is the intended friction: `tokenize`
already warns that every feature added is a concept a child can trip over, and
a command shipped without hint coverage trips them with no help.

## D14 — "No-Do" relaxed: name the verb, never the line

A hint may now write a bare command verb — "which command lists what is inside a
folder — `ls`?" — but still never a verb with its argument attached.

**Why:** review of the first drafted batch rejected candidate after candidate for
being true but useless. "Which command shows you what is written inside
something?" names a concept a child cannot act on when they do not yet know the
vocabulary. Naming the verb does not give the answer away, because the target is
the part they have to work out and type.

**What is unchanged:** `ls lighthouse`, `cd rocks`, `use 'cat notes.txt'` are all
still rejected, in the body and the title, quoted or introduced by an
instruction to type them. The child still supplies the argument, which is the
part that requires understanding where they are.

**Cost:** the line is finer than "no commands" and needs the predicate to hold
it. Two tests pin both sides — a named verb passes, a verb with an argument does
not — because this is the rule most likely to drift back under pressure to be
helpful.

## D15 — A template is about every world, not the one it was drafted against

The drafting input showed the model one directory and it wrote copy true of that
directory. Against the Lighthouse, whose root holds only folders, "which file did
you mean to read?" is false — and most of the first batch was rejected for
exactly that.

**Why it matters beyond drafting:** a template is universally quantified over
worlds satisfying its `requires`. Anything the copy assumes must be guaranteed by
the slot or a decorator, or the hint is wrong somewhere it can fire. That is also
why an under-specified `requires` is worse than an over-specified one: the
over-specified hint merely fires rarely, the under-specified one fires and lies.

**How it is enforced:** the drafting input now carries every scenario's starting
cwd and what is in it, labels the concrete example as one example, and the prompt
says to check the copy against all of them. Nothing mechanical catches a
violation yet — it remains the first of the three review questions.
