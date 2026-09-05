# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Omarchy Flish is a sandboxed terminal that teaches children shell basics. Input
is evaluated against an in-memory VFS, never a real shell. Errors print
authentically; when a child gets stuck, a hint is dispatched over a Unix socket
to a desktop overlay that runs inside Omarchy 4's `omarchy-shell`.

## Commands

```bash
cd tests && npm install && npm test  # templates + tutor logic, ~70ms, no desktop
node --test --test-name-pattern "No-Do"          # a single test
scripts/e2e-tutor.py                 # end-to-end, needs a live shell (~25s)
node tests/validate-candidate.js F   # gate one drafted hint (same rules as the suite)
tools/curate/draft.py --list         # uncovered slots: the authoring worklist
tools/curate/draft.py --models       # LM Studio models; drafting needs one LOADED

engine/scripts/build.sh             # debug build -> engine/build/omarchy-flish
engine/scripts/build.sh release     # -o:speed -no-bounds-check
engine/scripts/test.sh              # odin test tests
export FLISH_TEMPLATES_DIR="$PWD/templates/hints"    # else /usr/share/omarchy-flish/...
export FLISH_SCENARIOS_DIR="$PWD/templates/scenarios" # the world; missing is fatal

scripts/dev-install-tutor.sh        # validate + copy tutor/ into ~/.config/omarchy/plugins/
omarchy plugin enable flish.tutor   # writes the shell.json entry for you
omarchy-plugin-validate tutor       # manifest/entrypoint/symlink/reserved-id checks
```

`tests/` is a Node workspace (one devDependency, ajv) covering the hint
dictionary and the tutor's protocol logic; `tests/README.md` explains the layers
and lists what still needs manual eyes. Engine `test.sh` runs the whole `tests`
package and takes no filter argument. There is no linter.

### Developing the overlay

The engine cannot deliver a hint yet (see Current state), so the overlay is
developed against stand-ins:

```bash
scripts/fake-engine.py                  # hello + hint, prints ack/feedback back
scripts/fake-engine.py --ttl 0          # hold the card open while styling
scripts/fake-engine.py --long           # long body, shakes out layout bugs
scripts/fake-engine.py --dismiss-after 5

# Visuals only, no socket needed -- the shell summons the panel directly:
omarchy-shell shell summon flish.tutor '{"v":1,"type":"hint","id":"t1","title":"T","body":"B","ttl_ms":0}'

# Invoke a panel method without a mouse (routes to loader.item[method]):
omarchy-shell shell call flish.tutor answer helpful
```

Debugging: `qs list --all` to find the shell instance, then
`qs log -i <id> -t 50` for QML warnings — a plugin that fails to load says so
only there. `hyprctl layers | grep -A4 flish` shows the mapped layer surface.

**Hot-reload is unreliable in practice.** Saving under
`~/.config/omarchy/plugins/` is supposed to reload plugin code, but stale QML
has survived both a re-copy and `omarchy-shell shell rescanPlugins`. When a
change does not appear to take, `omarchy restart shell` always settles it —
check that before debugging the code.

## Architecture

Three components, one repo, laid out along the seams they will eventually split
along. They never import each other by path.

| Dir | Language | Meets the others at |
|---|---|---|
| `engine/` | Odin | `docs/ipc-protocol.md`, `templates/schema/` |
| `tutor/` | QML (Quickshell plugin) | `docs/ipc-protocol.md` |
| `templates/` | JSON | `templates/schema/hint.schema.json` |
| `tools/curate/` | prompts, dev-only | never shipped, never read at runtime |

Anything crossing the engine/tutor line updates `docs/ipc-protocol.md` **first**.
`docs/decisions.md` records why each choice was made and what it costs; read the
relevant entry before reversing one.

Engine package graph is acyclic and fixed:
`vfs → commands → session → hints → {ipc, telemetry}`, with `main` wiring them
and owning a per-turn arena reset every REPL turn.

### Slots: the unit of hint coverage

`session.signature_of` keys strikes on `command/status`, not on the argument, so
a **slot** is one `(command, status)` pair and is the unit that can earn a hint.
Decorators (`requires`) split a slot into lessons; they never create new slots.

`templates/schema/slots.json` enumerates every slot the engine can produce and is
the authoring worklist. Adding a command means editing three things together: the
builtin, its slots, and its hints. A drift test parses `commands.odin` and fails
when the manifest disagrees, and a status declared but never assigned is caught
(that is how the dead `Permission_Denied` surfaced).

Precedence is **specificity, then min_strike, then id** — never directory order.
A decorator the status already implies (`target_exists` on a `Not_Found`) is
excluded from a slot's applicable list, because it discriminates nothing while
still inflating the specificity score. See D11.

The world is content too: `templates/scenarios/*.json`, loaded at startup and
doubling as the fixture a hint's decorators are tested against. A hint requiring
`target_in_parent` is only reachable in a scenario shaped that way.

### The IPC seam

NDJSON over `$XDG_RUNTIME_DIR/omarchy-flish/tutor.sock`, falling back to
`/run/user/$UID/...`. **The tutor listens; the engine connects** — the shell is
the long-lived side, so engines multiplex as connections and an early engine
just retries (D6). Messages: `hello`/`hint`/`dismiss` out, `feedback`/`ack`
back. Unknown types and unknown `v` are ignored, never errors.

Degraded mode is mandatory: if the socket is missing or blocks, the engine
continues with zero user-visible change and never prints an IPC error to the
child's terminal.

### The Omarchy shell plugin contract

The host source is readable at `/usr/share/omarchy/shell` — read it rather than
guessing at the API. `shell.qml` is the host, `services/PluginRegistry.qml` the
validator, `Commons/` the design tokens (`Style`, `Color`, `Util`, `Border`),
`Ui/` the component library (`omarchy dev ui preview` renders a live gallery).

What the host does with a plugin, and the traps in it:

- A `panel` plugin must expose `open(payloadJson)` and `close()`. `summon`
  queues the payload and calls `open()`; `hide` calls `close()`.
- On load the host **assigns** `omarchyPath`, `shell`, `manifest`,
  `barWidgetRegistry`, `pluginRegistry`, and `service` onto the instance. Any of
  these declared `readonly` throws a TypeError that aborts the host's `onLoaded`
  *before* it registers the panel — the plugin then silently never receives
  `open()`. Declare them writable.
- The service and panel halves are created by independent code paths, so neither
  is guaranteed first. Resolve cross-references at call time, not at load.
- `keepLoaded: true` keeps the panel mounted between summons.
- Third-party plugins are enabled iff their id appears in
  `~/.config/omarchy/shell.json`; the `omarchy.*` id namespace is reserved and
  symlinks anywhere inside a plugin folder are rejected (hence D8, and why the
  install script copies).
- **QML types cannot be loaded outside the Quickshell binary** — `qmltestrunner`
  fails with `plugin "quickshell-coreplugin" not found`. Anything left in a
  `.qml` file is only reachable through a running shell, so pure logic belongs
  in a `.js` file beside it (`tutor/TutorProtocol.js`; upstream does the same
  with `NotificationLogic.js`, `OsdModel.js`). Keep those files free of QML
  types, imports, I/O and `new Date()` so both QML and Node can load them.
- A fullscreen layer-shell surface swallows every desktop click unless the input
  region is punched back out with `mask: Region { item: theCard }`. There is no
  `pointer-events: none`. Prefer a fixed fullscreen surface over one sized to
  content — resizing renegotiates the Wayland surface and the compositor briefly
  scales a stale buffer.

Closest first-party references: `plugins/osd/` (transient summoned card),
`plugins/notifications/` (per-output `Variants`, masking, action buttons).

## Product constraints that look like bugs if you don't know them

- **Errors are never suppressed or reworded.** Reading them is the lesson; the
  overlay translates, it does not replace (D3).
- **"No-Do": hints ask, never instruct.** A hint body must not contain a
  runnable command line — the child types the answer. The schema caps `body` at
  240 chars partly to make violating this awkward.
- **No model ships.** Hints are a fixed dictionary of human-approved JSON.
  Unmatched failures produce *no hint*, which is the correct failure mode (D1).
  Two failures printing the same error but teaching different lessons are two
  templates separated by `requires` decorators, not one hedged template.
- **"Curation", not "distillation"** — the words are load-bearing and legally
  loaded; see D9 before renaming anything in `tools/curate/`.
- **Telemetry is children's data.** It goes to `$XDG_STATE_HOME/omarchy-flish/`,
  never the working directory; sync is off by default and opt-in. Raw telemetry
  and fixtures are gitignored and require `git add -f` plus reviewed redaction.
  `NOTICE.md` asks that none of it — or the hint copy — become training data, at
  any model size. Code is MIT; the data ask sits alongside it.

## Current state

- **Engine: scaffolding, never compiled.** Odin is not installed here. Expect
  API drift on first build; `engine/README.md` lists the likely breakages.
- **Engine IPC is a stub.** `core:net` has no AF_UNIX type, so `ipc.connect`
  always returns disconnected and the engine runs permanently degraded. Needs
  `core:sys/linux`. This is why `scripts/fake-engine.py` exists.
- **Hint dictionary covers 2 of 8 slots.** `tools/curate/draft.py --list` shows
  the rest. Drafting runs against a local LM Studio model and every candidate
  passes `tests/validate-candidate.js` before a human reads it; nothing reaches
  `templates/hints/` without a person moving it (D9). Drafting refuses an
  unloaded model by default — it loops, and a just-in-time load of several large
  models is not something to trigger unattended on someone else's hardware.
- **Regex is unimplemented.** `match.stderr` is specified as a regex but
  compared as a substring; the `{{target}}` extraction wants named captures.
  Decide `core:text/regex` vs a PCRE2 binding (D2).
- **Tutor overlay works end to end** against the fake engine: hint renders,
  `ack` and `feedback` round-trip, dismiss is id-scoped, TTL and disconnect both
  retire the card. Verified by `scripts/e2e-tutor.py` (6/6 on a live shell).
- **Not machine-verified:** the overlay's click-through mask. `hyprctl` does not
  expose input regions and no pointer-injection tool is installed, so it is on
  the manual checklist in `tests/README.md`.
