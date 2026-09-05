# Tests

Three layers, split by what infrastructure each one needs.

| Layer | Location | Needs | In CI |
|---|---|---|---|
| Hint dictionary | `templates/` | Node | yes |
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
