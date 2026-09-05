import QtQuick
import Quickshell
import Quickshell.Io

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

  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || ""
  readonly property string socketDir: (runtimeDir !== "" ? runtimeDir : "/tmp") + "/omarchy-flish"
  readonly property string socketPath: socketDir + "/tutor.sock"

  // hintId -> the Socket that delivered it, so feedback goes back to the engine
  // that actually asked. Cleared when a connection drops; a late click on a
  // hint from a closed terminal is dropped rather than misrouted.
  property var hintOrigins: ({})

  Component.onCompleted: prepareSocket.running = true

  // A socket file left behind by a crashed shell would make listen() fail, so
  // create the directory and clear the path before the server claims it.
  Process {
    id: prepareSocket
    command: ["sh", "-c", 'mkdir -p "$1" && rm -f "$2"', "sh", root.socketDir, root.socketPath]
    onExited: function (code) {
      if (code === 0) server.active = true
      else console.warn("flish.tutor: could not prepare socket dir:", root.socketDir)
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

  function handleLine(socket, line) {
    var text = String(line || "").trim()
    if (text === "") return

    var message
    try {
      message = JSON.parse(text)
    } catch (e) {
      // A malformed line is the engine's bug, not the child's problem.
      console.warn("flish.tutor: unparseable IPC line")
      return
    }

    // Forward compatibility: anything newer than this build understands, and
    // any type it does not know, is ignored rather than treated as an error.
    if (Number(message.v) !== 1) return

    switch (message.type) {
    case "hello":
      return
    case "hint":
      return root.showHint(socket, message)
    case "dismiss":
      return root.dismiss(message)
    }
  }

  function showHint(socket, message) {
    var id = String(message.id || "")
    if (id === "") return

    var origins = ({})
    for (var key in root.hintOrigins) origins[key] = root.hintOrigins[key]
    origins[id] = socket
    root.hintOrigins = origins

    if (root.shell) root.shell.summon("flish.tutor", JSON.stringify(message))
  }

  function dismiss(message) {
    if (root.shell) root.shell.hide("flish.tutor")
  }

  // --------------------------------------------------------------- outbound

  // Called by HintPanel.qml when the child taps 👍 or 👎.
  function sendFeedback(hintId, verdict) {
    var socket = root.hintOrigins[hintId]
    if (!socket || !socket.connected) return

    socket.write(JSON.stringify({
      v: 1,
      type: "feedback",
      id: hintId,
      verdict: verdict,
      at: new Date().toISOString()
    }) + "\n")
    socket.flush()
  }

  function forgetConnection(socket) {
    var origins = ({})
    for (var key in root.hintOrigins)
      if (root.hintOrigins[key] !== socket) origins[key] = root.hintOrigins[key]
    root.hintOrigins = origins
  }
}
