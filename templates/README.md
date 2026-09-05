# Template dictionary

> **Data use:** this copy was drafted with commercial language models and
> rewritten by people. Please do not use it as training data — see
> [`../NOTICE.md`](../NOTICE.md).

The offline "AI". Every hint a child can ever see is a file in
[`hints/`](hints), validated against
[`schema/hint.schema.json`](schema/hint.schema.json).

This directory is the future `omarchy-flish-templates` repository. It has no
build step and no dependency on the engine: a contributor writing hint copy
should never need an Odin compiler.

## Where this copy comes from

A developer drafts candidates with a live model over beta telemetry, then
rewrites and approves the final wording by hand. The model never writes what
ships. The project calls this *curation*, not *distillation*: nothing is
trained and no weights are derived. See `../docs/decisions.md`, D9.

## Rules for hint copy

1. **Ask, never instruct.** A hint that contains a runnable command line has
   done the child's work. This is the "No-Do" constraint and it is not
   negotiable — the schema caps `body` length partly to make violating it
   awkward.
2. **Point at the real error.** The child has already seen the authentic
   terminal output. Good copy references it ("the terminal said *Not a
   directory*") so the error becomes readable rather than being replaced.
3. **One idea per hint.** If it needs two sentences of setup, it is two hints,
   or it is a scenario design problem.
4. **Decorators over cleverness.** Two failures that print the same error but
   mean different things are two templates separated by `requires`, not one
   template with hedged wording.

## Loading

The engine reads `$FLISH_TEMPLATES_DIR` when set, otherwise
`/usr/share/omarchy-flish/templates/hints`. For development:

```bash
export FLISH_TEMPLATES_DIR="$PWD/templates/hints"
```
