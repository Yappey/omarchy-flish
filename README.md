# Omarchy Flish 🐚

**F**un **L**earning **I**nteractive **SH**ell — a high-performance, sandboxed
terminal learning environment for kids, built for Omarchy 4.

Flish mimics a real Linux shell, but instead of executing dangerous commands it
evaluates input against an in-memory Virtual File System. Errors are printed
**authentically**, because reading them is the lesson. When a learner gets
stuck, Flish dispatches a contextual, Socratic hint over IPC to a desktop
overlay — out of band, so the terminal stays a terminal.

## Features

- **Safe by design.** Zero real system access. Every path resolves inside the VFS.
- **Authentic pedagogy.** Errors are never suppressed or reworded. The overlay
  translates; it does not replace.
- **Deterministic "AI".** A curated dictionary of offline templates plus VFS
  state decorators gives instant, reproducible hints with no local model. The
  same mistake always yields the same hint — which is what makes it teachable.
- **Omarchy 4 native.** The tutor is a Quickshell plugin inside the running
  `omarchy-shell` process, not a second desktop app.
- **Small and predictable.** The engine is Odin: a tiny static binary with
  arena allocation and no GC, so there is no collection pause mid-keystroke.

## Repository layout

One repository today, laid out along the boundaries it will eventually split
along. `engine/`, `tutor/`, and `templates/` never import each other by path;
they meet only at the documented contracts.

| Path | What it is | Splits into |
|---|---|---|
| `engine/` | Odin core: REPL, VFS, strikes, IPC client, telemetry | `omarchy-flish` |
| `tutor/` | Quickshell (QML) plugin: hint overlay + IPC server | `omarchy-flish-tutor` |
| `templates/` | Offline hint dictionary + JSON schema | `omarchy-flish-templates` |
| `tools/curate/` | Dev-only LLM prompts and curation tooling. Never shipped. | stays here |
| `docs/` | Architecture, IPC protocol, decision log | shared |

The seam between engine and tutor is [`docs/ipc-protocol.md`](docs/ipc-protocol.md).
Read it before changing either side.

## Getting started

### Prerequisites

- [Odin](https://odin-lang.org) — on Arch/Omarchy: `sudo pacman -S odin`
  (packaged as dated releases, e.g. `dev_2026_08`; there is no semantic version)
- Omarchy 4 with Quickshell, for the tutor overlay. The engine builds and runs
  without it — hints simply do not fire.

### Build and run the engine

```bash
engine/scripts/build.sh
export FLISH_TEMPLATES_DIR="$PWD/templates/hints"
engine/build/omarchy-flish
```

### Tests

```bash
cd tests && npm install && npm test   # hint dictionary + tutor logic
engine/scripts/test.sh                # engine (needs Odin)
scripts/e2e-tutor.py                  # overlay end to end (needs a live shell)
```

[`tests/README.md`](tests/README.md) covers the layers and the checks that still
need a human looking at the screen.

### Install the tutor overlay

```bash
scripts/dev-install-tutor.sh
```

A third-party plugin is enabled iff its id appears in
`~/.config/omarchy/shell.json`. Let Omarchy write that entry for you:

```bash
omarchy plugin enable flish.tutor
```

### Develop the overlay without the engine

The engine's socket client is not implemented yet, so the tutor is developed
against a stand-in that speaks the same protocol:

```bash
scripts/fake-engine.py                 # a hint, then wait for ack + feedback
scripts/fake-engine.py --ttl 0         # hold the card open while you style it
scripts/fake-engine.py --long          # a long body, to shake out layout bugs
```

To iterate on the card's visuals alone, no socket is needed at all — the shell
will summon the panel directly:

```bash
omarchy-shell shell summon flish.tutor '{"v":1,"type":"hint","id":"t1","title":"That is a file, not a folder","body":"Which command shows you what is written inside something?","ttl_ms":0}'
```

Saving a file under `~/.config/omarchy/plugins/` hot-reloads plugin code. If a
change does not seem to take, `omarchy restart shell` always settles it.

## Contributing

- Terminal logic, VFS, IPC, telemetry → `engine/`
- Hint overlay visuals and interaction → `tutor/`
- New hint scenarios and templates → `templates/` (no compiler needed)
- Anything crossing the engine/tutor line → update `docs/ipc-protocol.md` first

## Data use

Flish collects session telemetry from children, and its shipped hint copy was
drafted with help from commercial language models. **Please do not turn anything
in this repository, or any telemetry it produces, into model weights or a shared
training corpus** — at any model size, including a small open-weights model
fine-tuned on your own machine.

A parent using a local model to help their own child, transiently, is their own
business. The line is permanence and reach, not model size.
[NOTICE.md](NOTICE.md) explains what is and is not being asked, and why.

## License

MIT. See [LICENSE](LICENSE). `NOTICE.md` covers data use, which the MIT licence
does not speak to.
