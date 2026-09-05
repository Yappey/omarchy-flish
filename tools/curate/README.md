# Curation tooling (developer only)

> **Data use:** the telemetry this tooling consumes comes from children, and the
> copy it helps produce was drafted with commercial language models. Please do
> not train on any of it — see [`../../NOTICE.md`](../../NOTICE.md).

Phase 1 of the lifecycle in
[`../../docs/architecture.md`](../../docs/architecture.md#5-the-hint-curation-lifecycle).

Nothing in this directory is packaged, installed, or read by the engine at
runtime. It exists so a developer can turn opt-in beta telemetry into curated
JSON templates. **If a change here can affect what a child sees without a human
reviewing a template file, that change is wrong.**

## This is authoring, not distillation

The model drafts; a person decides. There is no student model, no training
step, and no derived weights — the output is a JSON lookup table written and
approved by a human being. The project deliberately avoids the word
"distillation" for this, because it names a different thing (training a smaller
model on a larger one's outputs) that is prohibited by most model providers'
terms. See `../../docs/decisions.md`, D9.

## Why the prompts live here and not in `templates/`

`templates/` is the shipped artifact: reviewed, deterministic, offline. These
prompts are the *machinery that proposes candidates* for it. Keeping them apart
means the packaging rule is trivially checkable — `templates/` ships, `tools/`
does not — and a contributor can never accidentally wire a live model into a
child's path.

## Layout

```
prompts/     System prompts for the live LLM used during beta sessions.
fixtures/    Redacted telemetry samples used to test prompt changes.
```

`fixtures/` is gitignored by default. Adding one takes a deliberate
`git add -f`, and redaction must be reviewed before it goes in — see
[`../../NOTICE.md`](../../NOTICE.md#what-actually-protects-the-data).

## Workflow

1. A beta tester (opt-in, adult-consented) hits a failure with live hinting on.
2. The model drafts an answer using `prompts/tutor-live.md`.
3. Telemetry lands as NDJSON with the command, error, VFS decorators, and the
   child's 👍/👎.
4. A developer runs `prompts/curate-template.md` over a cluster of similar
   events to propose a template.
5. **A human reviews, rewrites, and approves it**, then commits it to
   `templates/hints/`.

Step 5 is the whole point. There is no automated path from model output to
shipped copy, and adding one would change what this project is.
