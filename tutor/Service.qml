import QtQuick
import Quickshell
import Quickshell.Io
import "TutorProtocol.js" as TutorProtocol

// The tutor's listening half. See ../docs/ipc-protocol.md.
//
// This is the server because it is the long-lived side: it lives inside the
// omarchy-shell process, while engines come and go with terminal windows. Each
// open Flish terminal is one connection, and all of them are multiplexed here.
Item {
  id: root

  // Injected by the shell host when the service is mounted.
  property var shell: null
  property var manifest: null

  // Resolved by prepareSocket below rather than in QML, so the fallback for an
  // unset XDG_RUNTIME_DIR is /run/user/$(id -u) -- byte-for-byte what the
  // engine computes in engine/src/ipc/ipc.odin. QML has no getuid(), and a
  // tutor listening somewhere the engine never dials is a silent failure.
  property string socketDir: ""
  readonly property string socketPath: socketDir !== "" ? socketDir + "/tutor.sock" : ""

  // The tutor shows one hint at a time, so it only ever needs the origin of the
  // hint currently on screen: that is the only one whose buttons can still be
  // pressed. Keeping a single pair instead of an id->socket map means there is
  // nothing to leak when a hint is replaced rather than answered.
  property string currentHintId: ""
  property var currentSocket: null

  Component.onCompleted: prepareSocket.running = true

  // A socket file left behind by a crashed shell would make listen() fail, so
  // create the directory and clear the path before the server claims it. The
  // resolved directory comes back on stdout.
  Process {
    id: prepareSocket
    command: ["sh", "-c",
      'dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/omarchy-flish"; mkdir -p "$dir" && rm -f "$dir/tutor.sock" && printf %s "$dir"']
    stdout: StdioCollector {
      onStreamFinished: root.socketDir = String(text || "").trim()
    }
    onExited: function (code) {
      if (code === 0 && root.socketDir !== "") server.active = true
      else console.warn("flish.tutor: could not prepare socket dir")
    }
  }

  SocketServer {
    id: server
    active: false
    path: root.socketPath

    handler: Socket {
      id: connection
      parser: SplitParser {
        splitMarker: "\n"
        onRead: function (line) { root.handleLine(connection, line) }
      }
      onConnectionStateChanged: if (!connection.connected) root.forgetConnection(connection)
    }
  }

  // ---------------------------------------------------------------- inbound

  // Routing lives in TutorProtocol.classifyLine so the version and type rules
  // are testable without a shell. Unknown types and unknown versions are
  // ignored, never errors -- that is the forward-compatibility hinge for v1.x.
  function handleLine(socket, line) {
    var decision = TutorProtocol.classifyLine(line)

    if (decision.reason === "unparseable")
      // A malformed line is the engine's bug, not the child's problem.
      console.warn("flish.tutor: unparseable IPC line")

    switch (decision.action) {
    case "hint":
      return root.showHint(socket, decision.message)
    case "dismiss":
      return root.dismiss(decision.message)
    }
  }

  function showHint(socket, message) {
    var id = TutorProtocol.hintIdOf(message)
    if (id === "") return

    root.currentHintId = id
    root.currentSocket = socket

    if (root.shell) root.shell.summon("flish.tutor", JSON.stringify(message))
  }

  // Only the engine that owns the hint on screen may take it down. Without the
  // id check, one child's terminal resetting would yank the hint another
  // terminal is still showing.
  function dismiss(message) {
    if (!TutorProtocol.shouldDismiss(message, root.currentHintId)) return
    root.clearCurrent()
    if (root.shell) root.shell.hide("flish.tutor")
  }

  // --------------------------------------------------------------- outbound

  function send(socket, payload) {
    if (!socket || !socket.connected) return false
    socket.write(JSON.stringify(payload) + "\n")
    socket.flush()
    return true
  }

  // Called by HintPanel.qml once a hint has actually reached a screen. Lets the
  // engine tell "this hint did not help" apart from "this hint was never seen".
  function sendAck(hintId) {
    if (hintId !== root.currentHintId) return
    root.send(root.currentSocket, TutorProtocol.ackPayload(hintId))
  }

  // Called by HintPanel.qml when the child taps a feedback button.
  function sendFeedback(hintId, verdict) {
    if (hintId !== root.currentHintId) return
    root.send(root.currentSocket,
      TutorProtocol.feedbackPayload(hintId, verdict, new Date().toISOString()))
  }

  function clearCurrent() {
    root.currentHintId = ""
    root.currentSocket = null
  }

  // The terminal that asked for this hint has gone away, so the hint has gone
  // stale: its buttons can no longer reach anyone, and at ttl_ms 0 it would sit
  // on the desktop indefinitely. Take it down with the connection.
  function forgetConnection(socket) {
    if (root.currentSocket !== socket) return
    root.clearCurrent()
    if (root.shell) root.shell.hide("flish.tutor")
  }
}
