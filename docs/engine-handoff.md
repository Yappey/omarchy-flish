# Engine handoff — quick reference

For whoever picks up the Odin side. Everything outside `engine/` has moved a
long way while the engine has not been compiled once, so this is the map between
the two and an honest list of what is trustworthy.

## Start here

```bash
sudo pacman -S odin                 # Arch/Omarchy; packaged as dated releases

export FLISH_TEMPLATES_DIR="$PWD/templates/hints"
export FLISH_SCENARIOS_DIR="$PWD/templates/scenarios"

engine/scripts/build.sh             # debug -> engine/build/omarchy-flish
engine/scripts/test.sh              # odin test tests
engine/build/omarchy-flish
```

Both env vars are now required in development. A missing scenario is fatal by
design — hints are an enhancement, a world is not — so the binary exits 2 with
the path it tried rather than starting an empty island.

## The first job

**Nothing in `engine/` has been through a compiler.** Odin was never installed
on the machine this was written on. The structure and control flow are the
deliverable; expect to fix API drift on the first build.

Calls introduced without verification, most-suspect first:

| Where | Call | Why it might not compile |
|---|---|---|
| `hints/hints.odin:91` | `slice.sort_by(dictionary.templates[:], template_precedes)` | comparator signature; `[dynamic]T` → slice |
| `vfs/vfs.odin:71` | `json.unmarshal` into `Scenario` | `Scenario_Entry` is self-referencing via `[]Scenario_Entry` |
| `hints/hints.odin:258` | `json.unmarshal` into `Maybe(bool)` / `Maybe(int)` | optional-field decoding may need a custom path |
| `main.odin:43` | `filepath.join({dir, "starter.json"})` | slice-literal argument form |
| `vfs/vfs.odin:189` | `make([]int, n, context.temp_allocator)` | allocator argument position |
| `main.odin` | `os.exit`, `os.read_entire_file` | return arity |

If `Maybe(bool)` decoding is awkward, that is worth knowing early: the whole
decorator system depends on distinguishing *absent* from *false*.

## What the engine has to match

These are contracts, not suggestions. Each is validated on the JSON side by a
test that runs in CI, so if the Odin disagrees the mismatch is silent until
runtime.

| Contract file | Odin counterpart | Guarded by |
|---|---|---|
| `templates/schema/hint.schema.json` | `hints.Template`, `hints.Matcher`, `hints.Decorator` | `tests/templates/hints.test.js` |
| `templates/schema/scenario.schema.json` | `vfs.Scenario`, `vfs.Scenario_Entry` | `tests/templates/scenarios.test.js` |
| `templates/schema/slots.json` | `commands.Status` + the dispatch table | `tests/templates/slot-drift.test.js` |
| `docs/ipc-protocol.md` | `ipc.odin` ↔ `tutor/TutorProtocol.js` | `tests/tutor/protocol.test.js` |

`slot-drift.test.js` parses `commands.odin` directly and fails when the manifest
and the engine disagree, so **adding a command means editing three things in one
change**: the builtin, its slots in `slots.json`, and its hints.

### Decorators

Eight, in `hints.Decorator`, evaluated in `satisfies()`. Five are new and
unexercised:

`target_exists`, `target_is_file`, `cwd_has_children` (original) — plus
`target_near_sibling`, `target_in_parent`, `cwd_is_root`, `target_is_empty_dir`,
`argv_count`.

The near-sibling one leans on `vfs.edit_distance`, a plain Levenshtein over
bytes with a distance limit of 1 for names ≤ 4 chars and 2 above. That threshold
is a guess and should be tuned against real hint copy.

**A decorator implied by the status is excluded on purpose.** `Not_Found`
already means `target_exists: false`; declaring it adds nothing and inflates the
specificity score that decides precedence. `slots.json` lists only the
decorators that actually discriminate per slot, and the tests reject the rest.

### Precedence, and why it is not directory order

`load_dictionary` sorts by `template_precedes`: specificity descending, then
`min_strike` ascending, then id. Before that, `evaluate` returned the first match
in `os.read_dir` order, so which of two matching templates won depended on the
filesystem — and "the same mistake always yields the same hint" (D1) was
quietly false across machines.

`min_strike` is now honoured: it was parsed and never read, and the gate was
`count == 3` exactly, which made any higher value unreachable. It is a `>=`
comparison with a two-turn cooldown (`session.HINT_COOLDOWN_TURNS`) so a blunter
second hint can follow without stacking popups.

An absent `min_strike` is normalised to 3 at load. `json.unmarshal` leaves it
zero, which would fire every such template on the child's first failure.

## What is already proven

Trustworthy, because it was exercised against a live system rather than reasoned
about:

- **The tutor overlay works end to end.** `scripts/e2e-tutor.py` passes 6/6
  against a running `omarchy-shell`: ack round-trip, feedback, dismiss
  id-scoping across two engines, unknown-type tolerance, disconnect retiring a
  hint, and `ttl_ms: 0` holding past the default.
- **`scripts/fake-engine.py` speaks the engine's half of the protocol.** Use it
  as the reference for what `ipc.odin` should put on the wire, and as the thing
  to test against while implementing AF_UNIX.
- **`tests/fixtures/protocol/inbound.json`** is a golden set of wire lines with
  their expected classification, deliberately language-neutral so the Odin side
  can be tested against the same bytes the QML side is.
- 50 Node tests and 17 Python tests cover the dictionary, the scenarios, the
  slot manifest and the reply parsing. None of them cover Odin.

## Gaps, in the order they block things

1. **AF_UNIX sockets.** `core:net` has no Unix-domain type, so `ipc.connect`
   returns disconnected unconditionally and no hint has ever reached a screen
   from the engine. Needs `core:sys/linux`. `fake-engine.py` is the target to
   match; `e2e-tutor.py` is the acceptance test.
2. **Regex.** `match.stderr` is a regex in the schema and a substring compare in
   `matches()`. Named capture groups are what `{{target}}` extraction wants —
   confirm `core:text/regex` supports them before committing, or bind PCRE2
   (D2).
3. **Line editing.** `read_line` is a raw `os.read`: no history, no arrow keys,
   and no keystroke hook for mash detection.
4. **Mash thresholds.** `session.looks_like_mashing` is a guess and needs real
   telemetry before shipping (D4).

## Where the content came from

`templates/hints/` is drafted with a local model and gated before a human reads
it — `tools/curate/draft.py`, `tests/validate-candidate.js`, and
`tests/README.md` for the workflow. Relevant to the engine only in that the
dictionary will grow much faster than it has, so precedence and decorator
correctness matter more than the current two templates suggest.
