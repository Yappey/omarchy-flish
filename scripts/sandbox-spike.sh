#!/usr/bin/env bash
# Evidence for docs/proposals/real-sandbox.md, not a launcher.
#
# The proposal on the table is to replace the in-memory VFS with real programs
# running inside an OS sandbox. Several claims in that assessment could only be
# reasoned about in advance; this script turns them into observations:
#
#   1. whether bwrap runs here without root,
#   2. what the child's world looks like -- does `pwd` show `/`, and what does
#      `ls /` reveal once real programs have to be present to run,
#   3. the real stderr for the slots the hint dictionary already has,
#   4. that the host outside the jail is unreachable.
#
# Nothing here is used by the engine and nothing is kept: the world is built in
# a temporary directory and deleted on exit. Run as your normal user.
#
#   scripts/sandbox-spike.sh [scenario]      # default: lighthouse

set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
scenario="${1:-lighthouse}"
seed="$repo/templates/scenarios/$scenario.json"
[[ -f "$seed" ]] || { echo "no scenario $seed" >&2; exit 2; }
command -v bwrap >/dev/null || { echo "bwrap is not installed" >&2; exit 2; }

if [[ $EUID -eq 0 ]]; then
  echo "refusing to run as root: the point is to show it works without" >&2
  exit 2
fi

world="$(mktemp -d)"
trap 'rm -rf "$world"' EXIT

# Materialise the scenario the way a real-sandbox engine would at session start.
python3 - "$seed" "$world" <<'PY'
import json, os, sys
seed, root = sys.argv[1], sys.argv[2]
data = json.load(open(seed))
def build(entries, base):
    for e in entries:
        path = os.path.join(base, e["name"])
        if e["kind"] == "dir":
            os.mkdir(path)
            build(e.get("entries", []), path)
        else:
            with open(path, "w") as f:
                f.write(e.get("content", ""))
build(data["entries"], root)
PY
cwd="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cwd"])' "$seed")"

# Host coreutils are dynamically linked (ldd /usr/bin/ls), so the loader and
# libc have to be visible inside the jail at the paths the binary expects. That
# requirement is itself one of the findings: see "what the child can see".
jail() {
  bwrap \
    --unshare-all \
    --die-with-parent \
    --new-session \
    --clearenv \
    --setenv LC_ALL C \
    --setenv PATH /usr/bin \
    --bind "$world" / \
    --ro-bind /usr/bin/ls /usr/bin/ls \
    --ro-bind /usr/bin/cat /usr/bin/cat \
    --ro-bind /usr/bin/pwd /usr/bin/pwd \
    --ro-bind /usr/lib /usr/lib \
    --symlink usr/lib /lib64 \
    --chdir "$cwd" \
    "$@"
}

show() {
  printf '\n$ %s\n' "$*"
  set +e
  # stdin closed: a bare `cat` would otherwise sit waiting for the keyboard,
  # which is the stuck-with-no-failure state the proposal warns about.
  jail "$@" </dev/null 2>&1
  printf '[exit %s]\n' "$?"
  set -e
}

echo "== 1. runs without root"
echo "host uid $(id -u); $(bwrap --version); everything below ran as that uid"

echo
echo "== 2. what the child can see"
show pwd
show ls
show ls -a /

echo
echo "== 3. real stderr for slots the dictionary already has"
show ls lighthosue          # ls/Not_Found, near miss
show cat lighthouse         # cat/Is_A_Directory
show cat                    # cat/Bad_Usage -- no such error exists: it reads stdin
show notacommand            # */Unknown_Command, as reported by whatever launched it

echo
echo "== 4. the host is out of reach"
show cat /etc/hostname
show ls /home
