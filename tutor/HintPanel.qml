import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Hyprland
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

  // The service owns the sockets; the panel only asks it to send feedback.
  //
  // Writable, because the shell host assigns it directly when the panel loads:
  //   if ("service" in item) item.service = shell.serviceFor(id)
  // A readonly binding here throws a TypeError inside the host's onLoaded
  // handler, which aborts it before registerPanelLoader() runs -- and an
  // unregistered panel never receives open(), so no hint ever renders.
  property var service: null

  property bool opened: false
  property string hintId: ""
  property string hintTemplate: ""
  property string title: ""
  property string body: ""
  property int ttlMs: 12000

  // Set once the child answers, so the card can acknowledge the tap before it
  // goes away. Empty while the hint is still unanswered.
  property string verdict: ""

  // The output the hint was fired onto, captured at open() so the card cannot
  // hop monitors while the child is halfway through reading it.
  property string targetScreen: ""

  // ------------------------------------------------------------------ scale
  //
  // Omarchy's tokens are sized for an adult glancing at a status bar: ~12px
  // body, ~14px title. A 7-12 year old reading a full sentence needs more.
  // These scale through Style.fontPx/Style.space rather than hard-coding
  // pixels, so a user who bumps their shell font still gets a proportional
  // card, and the colours stay on the theme's tokens either way.
  readonly property int titleSize: Style.fontPx(1.75)
  readonly property int bodySize: Style.fontPx(1.4)
  readonly property int pad: Style.space(24)
  readonly property int cardWidth: Style.space(460)

  // The service and the panel are created by two independent code paths in the
  // host, so neither is guaranteed to exist first. Resolve at call time rather
  // than trusting whatever `service` held at load.
  function tutorService() {
    if (root.service) return root.service
    return root.shell ? root.shell.serviceFor("flish.tutor") : null
  }

  // Where the child is actually working. Empty means "could not tell", and the
  // card then shows on every output: a hint on the wrong screen is a bug, but a
  // hint on no screen at all is a worse one.
  function resolveTargetScreen() {
    var monitor = null
    try { monitor = Hyprland.focusedMonitor } catch (e) { monitor = null }
    return monitor ? String(monitor.name || "") : ""
  }

  function showsOn(screenInfo) {
    if (root.targetScreen === "") return true
    return screenInfo && String(screenInfo.name || "") === root.targetScreen
  }

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
    root.verdict = ""
    root.targetScreen = root.resolveTargetScreen()
    root.opened = true

    if (root.ttlMs > 0) {
      autoDismiss.interval = root.ttlMs
      autoDismiss.restart()
    } else {
      autoDismiss.stop()
    }

    // Tell the engine the hint reached a screen. This is what separates "the
    // hint did not help" from "the hint was never seen" in telemetry --
    // see ../docs/ipc-protocol.md.
    var svc = root.tutorService()
    if (svc && root.hintId !== "") svc.sendAck(root.hintId)
  }

  function close() {
    root.opened = false
    root.verdict = ""
    autoDismiss.stop()
    acknowledge.stop()
  }

  // The child tapped a button. Send the verdict, then hold the card just long
  // enough to show that the tap landed -- a card that vanishes on click reads
  // as the app eating the input rather than accepting it.
  function answer(newVerdict) {
    if (root.verdict !== "") return
    var svc = root.tutorService()
    if (svc && root.hintId !== "")
      svc.sendFeedback(root.hintId, newVerdict)
    root.verdict = newVerdict
    autoDismiss.stop()
    acknowledge.restart()
  }

  // ttl_ms of 0 means "stay until dismissed".
  Timer {
    id: autoDismiss
    repeat: false
    running: false
    onTriggered: root.close()
  }

  Timer {
    id: acknowledge
    interval: 1100
    repeat: false
    running: false
    onTriggered: root.close()
  }

  // One window per output, so the card can land on the screen the child is
  // actually typing on. Only the matching one is ever visible -- the tutor
  // shows a single hint at a time by design.
  Variants {
    model: Quickshell.screens

    PanelWindow {
      id: hintWindow
      required property var modelData
      screen: modelData
      visible: root.opened && root.showsOn(modelData)
      color: "transparent"

      WlrLayershell.namespace: "flish-tutor"
      WlrLayershell.layer: WlrLayer.Overlay
      // The card has buttons, so unlike a pure OSD it must accept clicks. It is
      // still never keyboard focusable: focus belongs to the terminal, always.
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
      exclusionMode: ExclusionMode.Ignore

      // Fixed fullscreen surface. Sizing the window to the card instead would
      // renegotiate the Wayland surface on every hint, and the compositor
      // briefly scales the stale buffer while it does -- which is what
      // stretches and squashes a card whose text length just changed.
      anchors { top: true; bottom: true; left: true; right: true }

      // ...which means the surface covers the whole screen, so the input region
      // has to be punched back down to the card. Without this the overlay would
      // swallow every click on the desktop. There is no pointer-events: none.
      mask: Region { item: card }

      BorderSurface {
        id: card

        // Bottom right, clear of the terminal text the child is reading. The
        // hint is a companion to the error, never a replacement for it, so it
        // must not cover the line it is talking about.
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.rightMargin: Style.space(24)
        anchors.bottomMargin: Style.space(24)

        width: root.cardWidth
        height: card.borderTop + root.pad + content.implicitHeight + root.pad + card.borderBottom

        color: Util.alpha(Color.background, 0.97)
        borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
        radius: Style.cornerRadius

        opacity: root.opened ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 120 } }

        ColumnLayout {
          id: content
          anchors.fill: parent
          anchors.topMargin: card.borderTop + root.pad
          anchors.rightMargin: card.borderRight + root.pad
          anchors.bottomMargin: card.borderBottom + root.pad
          anchors.leftMargin: card.borderLeft + root.pad
          spacing: Style.space(12)

          Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: root.title
            color: Color.popups.text
            font.family: Style.font.family
            font.pixelSize: root.titleSize
            font.bold: true
            wrapMode: Text.WordWrap
          }

          Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: root.body
            color: Util.alpha(Color.popups.text, 0.85)
            font.family: Style.font.family
            font.pixelSize: root.bodySize
            lineHeight: 1.35
            wrapMode: Text.WordWrap
          }

          // Buttons while the hint is unanswered; a short thank-you after, so
          // the tap visibly lands before the card leaves.
          RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: Style.space(4)
            spacing: Style.space(10)

            Text {
              visible: root.verdict !== ""
              Layout.fillWidth: true
              textFormat: Text.PlainText
              text: root.verdict === "helpful"
                ? "Glad that helped."
                : "Thanks -- we will make it clearer."
              color: Util.alpha(Color.popups.text, 0.85)
              font.family: Style.font.family
              font.pixelSize: root.bodySize
              wrapMode: Text.WordWrap
            }

            Item { Layout.fillWidth: true; visible: root.verdict === "" }

            Button {
              visible: root.verdict === ""
              text: "\u{1F44D} Helpful"
              fontSize: root.bodySize
              horizontalPadding: Style.space(16)
              verticalPadding: Style.space(12)
              onClicked: root.answer("helpful")
            }

            Button {
              visible: root.verdict === ""
              text: "\u{1F44E} Confusing"
              fontSize: root.bodySize
              horizontalPadding: Style.space(16)
              verticalPadding: Style.space(12)
              onClicked: root.answer("confusing")
            }
          }
        }
      }
    }
  }
}
