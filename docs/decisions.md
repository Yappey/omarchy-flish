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
