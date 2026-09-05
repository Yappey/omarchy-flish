import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

// The visible half of the tutor: one card, one question, two buttons.
//
// Deliberately not a chat window. The child reads a question, turns back to the
// terminal, and types the answer themselves -- the "No-Do" constraint from
// ../docs/architecture.md. No command line ever appears on this surface.
Item {
  id: root

  // Injected by the shell host.
  property var shell: null
  property var manifest: null

  property bool opened: false
  property string hintId: ""
  property string hintTemplate: ""
  property string title: ""
  property string body: ""
  property int ttlMs: 12000

  readonly property int pad: Style.spacing.panelPadding

  // The service owns the sockets; the panel only asks it to send feedback.
  readonly property var service: shell ? shell.serviceFor("flish.tutor") : null

  // Called by the shell host when summon() delivers a payload.
  function open(payloadJson) {
    var payload = {}
    try {
      payload = JSON.parse(payloadJson || "{}")
    } catch (e) {
      return
    }

    root.hintId = String(payload.id || "")
    root.hintTemplate = String(payload.template || "")
    root.title = String(payload.title || "")
    root.body = String(payload.body || "")
    root.ttlMs = Number(payload.ttl_ms || 12000)
    root.opened = true

    if (root.ttlMs > 0) {
      autoDismiss.interval = root.ttlMs
      autoDismiss.restart()
    } else {
      autoDismiss.stop()
    }
  }

  function close() {
    root.opened = false
    autoDismiss.stop()
  }

  function answer(verdict) {
    if (root.service && root.hintId !== "")
      root.service.sendFeedback(root.hintId, verdict)
    root.close()
  }

  // ttl_ms of 0 means "stay until dismissed".
  Timer {
    id: autoDismiss
    repeat: false
    running: false
    onTriggered: root.close()
  }

  PanelWindow {
    visible: root.opened
    color: "transparent"

    // Bottom right, clear of the terminal text the child is reading. The hint
    // is a companion to the error, never a replacement for it, so it must not
    // cover the line it is talking about.
    anchors { bottom: true; right: true }
    margins { bottom: Style.space(24); right: Style.space(24) }

    implicitWidth: Style.space(380)
    implicitHeight: card.height

    WlrLayershell.namespace: "flish-tutor"
    WlrLayershell.layer: WlrLayer.Overlay
    // The card has buttons, so unlike a pure OSD it must accept clicks. It is
    // still never keyboard focusable: focus belongs to the terminal, always.
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore

    BorderSurface {
      id: card
      width: parent.width
      height: card.borderTop + root.pad + content.implicitHeight + root.pad + card.borderBottom
      color: Util.alpha(Color.background, 0.97)
      borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
      radius: Style.cornerRadius
      opacity: root.opened ? 1 : 0

      ColumnLayout {
        id: content
        anchors.fill: parent
        anchors.topMargin: card.borderTop + root.pad
        anchors.rightMargin: card.borderRight + root.pad
        anchors.bottomMargin: card.borderBottom + root.pad
        anchors.leftMargin: card.borderLeft + root.pad
        spacing: Style.spacing.rowGap

        Text {
          Layout.fillWidth: true
          textFormat: Text.PlainText
          text: root.title
          color: Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.title
          font.bold: true
          wrapMode: Text.WordWrap
        }

        Text {
          Layout.fillWidth: true
          textFormat: Text.PlainText
          text: root.body
          color: Util.alpha(Color.popups.text, 0.8)
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.spacing.controlGap

          Item { Layout.fillWidth: true }

          Button {
            text: "👍 Helpful"
            onClicked: root.answer("helpful")
          }

          Button {
            text: "👎 Confusing"
            onClicked: root.answer("confusing")
          }
        }
      }
    }
  }
}
