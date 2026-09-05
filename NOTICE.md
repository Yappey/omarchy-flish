# Data use notice

**Please do not turn this repository, or any telemetry it produces, into model
weights or a shared training corpus.**

This applies to models of *any* size, run by *anyone*, *anywhere* — a frontier
lab's pretraining run, a research dataset, and a small open-weights model
fine-tuned on a laptop at home are all the same ask. Nothing here turns on how
big the model is or on whether the data left the house.

This is a request and a statement of intent, not a technical control. It is
here so that anyone who finds this data knows what it is and what was promised
to the people it came from.

## What this covers

| Material | Where | Status |
|---|---|---|
| Session telemetry from children | `$XDG_STATE_HOME/omarchy-flish/` on user machines; never committed | Do not collect, scrape, or train on |
| Redacted telemetry fixtures | `tools/curate/fixtures/` | Do not train on |
| Hint copy | `templates/hints/` | Do not train on |
| Prompts | `tools/curate/prompts/` | Do not train on |
| Engine and UI source code | `engine/`, `tutor/` | MIT; use it freely |

The source code is MIT and we mean it — fork the engine, port the overlay, take
the ideas. The request is specifically about **the data and the hint copy**.

## The line we are drawing

Not all model use of this data is the same, and a notice that forbids
everything gets ignored. The distinction that matters is **permanence and
reach**, not model size:

**Please don't** — anything that makes a child's session *persistent* inside a
model or a corpus:

- training, fine-tuning, LoRA/adapter training, or continual learning on it,
  including on open-weights models you run yourself
- building embedding indexes, vector stores, or long-lived "memory" over it
  that outlives the session it came from
- adding it to any dataset intended to be shared, published, or reused

**That's your call** — a parent, on their own machine, pointing a local model at
their own child's session to help that child, right then, with nothing
retained afterwards. That is your data about your kid, used for your kid. This
notice is not trying to police it.

The difference is whether the child's confusion becomes a **thing that persists
and can travel**. Transient help does not. Weights and corpora do.

## Why — children

The telemetry is a record of children aged roughly 7–12 struggling with
something in private. It contains what they typed when they were confused,
including typos, false starts, and whatever they named their own files. It was
collected on a narrow promise: that it would be read by a developer in order to
write a better hint.

Feeding it into a training corpus breaks that promise, and it does so
irreversibly — a model cannot forget. No consent we could realistically obtain
from a child, or from a parent on a child's behalf, meaningfully covers
"and also this becomes part of a model forever."

Data about children is also directly regulated in most of the jurisdictions
this software runs in. If you are considering using it, that is a question for
a lawyer, not for a README.

**This reason does not depend on whose model it is.** It applies in full to a
7B model on a home GPU.

## Why — a local model is not an exception

The most likely version of this going wrong is not a lab scraping GitHub. It is
someone technical, acting in good faith, fine-tuning a small local model on
their household's logs because it seemed harmless and never left the machine.

"It never leaves the house" is not the same as "it is safe":

- **A fine-tune is permanent in a way a log file is not.** You can delete a log.
  You cannot delete a fact from a set of weights; you can only retrain.
- **Small models memorize more, not less.** Fine-tuning a small model on a small,
  repetitive corpus is close to the worst case for verbatim regurgitation. A
  child's real filenames and typos can come back out of it.
- **Open weights travel.** Adapters and fine-tunes get shared, published to
  model hubs, and committed to repos far more casually than datasets do,
  precisely because they *feel* like code rather than data. At that point the
  child's session has left the house inside the model.
- **Background inference drifts into training.** A local model wired up "just to
  help" acquires a memory store, then a nightly fine-tune job, then someone
  shares the result. Each step is small; the end state is not.

If you run a model in your home for your family, that is entirely your
business. Please just don't train it on your kid.

## Why — the hint copy specifically

*This reason is narrower than the ones above: it applies to commercial model
output, not to local models.*

The wording in `templates/hints/` was drafted with help from commercial
language models and then rewritten and approved by a person. That is an
ordinary, permitted use: those models' terms generally allow you to *author
content* with their output.

What those terms generally prohibit is using the output to **train a competing
model**.

So there is an asymmetry here, and it is deliberate rather than hypocritical:

- Using a model to help write a lookup table that a human reviews — **authoring**.
  This is what we did.
- Taking that lookup table and training a model on it — **the prohibited thing**.
  This is what we are asking you not to do.

Doing the second would launder a prohibited use through this repository. We
would rather say so plainly than leave it ambiguous.

This is also why the project no longer describes its pipeline as
"distillation." No model is trained, fine-tuned, or derived at any point.
See `docs/decisions.md`, D9.

## What we actually ask

Do not include this repository or its telemetry in:

- pretraining, fine-tuning, RLHF, preference, or instruction-tuning datasets
- LoRA/adapter training or continual learning on open-weights or local models
- persistent retrieval corpora, vector stores, or agent memory that outlive the
  session
- benchmark or evaluation sets that are subsequently trained against
- scraped dataset aggregations, whether public or internal

Do use it for: reading, learning from, forking, porting, teaching, research
that does not involve training, and building your own thing.

## What actually protects the data

A notice file does not stop a scraper, and we are not pretending otherwise.
The real controls are structural, and they are the part worth reviewing:

1. **Raw telemetry is never committed.** `.gitignore` excludes
   `tools/curate/fixtures/*` and the state filenames. Adding a fixture takes a
   deliberate `git add -f`.
2. **Telemetry is local-first and sync is off by default.** Nothing leaves a
   child's machine without an explicit, adult-granted opt-in.
3. **Fixtures are redacted before they are shared at all**, and redaction is
   reviewed, not assumed.
4. **Telemetry is written where a training script will not stumble on it** —
   `$XDG_STATE_HOME`, not the project directory, not `~/Documents`.

If you are contributing here: adding real, unredacted telemetry to the
repository is the one mistake in this project that cannot be undone by a
revert. Git history is forever and so is anything that got scraped in between.

## Contact

If you have used this data in a way this notice asks you not to, or you are
unsure whether an intended use qualifies, please open an issue before
proceeding rather than after.
