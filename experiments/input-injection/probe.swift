/// Which input-injection channels actually work, measured rather than assumed.
///
/// Freeform dragging is the one capability the accessibility path cannot
/// express — the action vocabulary has no drag — so the question is whether a
/// public API can synthesise one. This probe answers it on the machine you run
/// it on, because the answer turned out not to match the documentation or the
/// published reverse-engineering.
///
/// Measured on macOS 26.5.2 / arm64, from a process holding Accessibility
/// permission by inheritance from its terminal:
///
///   channel                          keyboard   mouse move   mouse click
///   CGEvent.postToPid (per process)  works      -            ignored
///   CGEvent.post (global HID)        -          works        ignored
///   AXUIElementPerformAction         -          -            works
///
/// The last row is why the desktop provider drives applications through
/// accessibility actions. The middle row is the surprise: the cursor obeys a
/// synthesised move, so the events are reaching the window server, yet a click
/// posted at a verified-correct coordinate does not reach the application.
///
/// That leaves the "give up the cursor and click like a user" fallback
/// unavailable too, at least from a process trusted this way. Whether a helper
/// with its own Accessibility grant behaves differently is the open question,
/// and it decides whether freeform drag needs a private API or only a
/// properly-signed binary.
///
/// Build and run (Calculator is the target; it is launched in the background):
///     swiftc -O probe.swift -o probe && ./probe
///
/// The mouse tests move the real cursor. It is put back afterwards.

import AppKit
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func stringAttribute(_ element: AXUIElement, _ key: String) -> String {
  (attribute(element, key) as? String) ?? ""
}

func actionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return (names as? [String]) ?? []
}

func frame(_ element: AXUIElement) -> CGRect? {
  guard let value = attribute(element, "AXFrame") else { return nil }
  var rect = CGRect.zero
  guard AXValueGetValue(value as! AXValue, .cgRect, &rect) else { return nil }
  return rect
}

let BUNDLE = "com.apple.calculator"

guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == BUNDLE }) else {
  print("launch Calculator first:  open -g -a Calculator")
  exit(1)
}
let pid = app.processIdentifier
let axApp = AXUIElementCreateApplication(pid)

/// Whatever the calculator is showing: the only honest way to tell an action
/// apart from an action that merely returned success.
func display() -> String {
  var latest = ""
  func walk(_ element: AXUIElement, _ depth: Int) {
    if depth > 25 { return }
    if stringAttribute(element, kAXRoleAttribute as String) == "AXStaticText" {
      let value = stringAttribute(element, kAXValueAttribute as String)
      if !value.isEmpty { latest = value }
    }
    for child in children(element) { walk(child, depth + 1) }
  }
  walk(axApp, 0)
  return latest
}

/// Screen rect of a digit key, and the element itself.
func digit(_ label: String) -> (AXUIElement, CGRect)? {
  var found: (AXUIElement, CGRect)?
  func walk(_ element: AXUIElement, _ depth: Int) {
    if depth > 25 || found != nil { return }
    var title = stringAttribute(element, kAXTitleAttribute as String)
    if title.isEmpty { title = stringAttribute(element, kAXDescriptionAttribute as String) }
    if title == label, actionNames(element).contains(kAXPressAction as String), let box = frame(element) {
      found = (element, box)
      return
    }
    for child in children(element) { walk(child, depth + 1) }
  }
  walk(axApp, 0)
  return found
}

guard let (key, box) = digit("9") else { print("could not find the 9 key"); exit(1) }
let point = CGPoint(x: box.midX, y: box.midY)
let screenHeight = NSScreen.main!.frame.height
let savedCursor = NSEvent.mouseLocation

print("target: \(BUNDLE) pid=\(pid) active=\(app.isActive)")
print("the 9 key sits at (\(Int(point.x)), \(Int(point.y)))\n")

func report(_ channel: String, _ before: String) {
  Thread.sleep(forTimeInterval: 0.7)
  let after = display()
  let active = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == BUNDLE }?.isActive ?? false
  print("  \(channel.padding(toLength: 34, withPad: " ", startingAt: 0)) \(before) -> \(after)"
    + "   worked=\(before != after)  appActive=\(active)")
}

let source = CGEventSource(stateID: .hidSystemState)

// 1. Keyboard, addressed to the process. Numpad 9.
var before = display()
for isDown in [true, false] {
  CGEvent(keyboardEventSource: source, virtualKey: 0x5C, keyDown: isDown)?.postToPid(pid)
  usleep(80_000)
}
report("keyboard via postToPid", before)

// 2. Mouse click, addressed to the process.
before = display()
for type in [CGEventType.leftMouseDown, .leftMouseUp] {
  CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.postToPid(pid)
  usleep(100_000)
}
report("mouse click via postToPid", before)

// 3. Mouse click through the global HID stream — the channel that moves the
//    real cursor, tried across every tap because the obvious one failed.
for (tap, label) in [(CGEventTapLocation.cghidEventTap, "cghidEventTap"),
                     (.cgSessionEventTap, "cgSessionEventTap"),
                     (.cgAnnotatedSessionEventTap, "cgAnnotatedSessionEventTap")] {
  CGWarpMouseCursorPosition(point)
  Thread.sleep(forTimeInterval: 0.25)
  let landed = NSEvent.mouseLocation
  let cursorOnTarget = abs(landed.x - point.x) < 2 && abs((screenHeight - landed.y) - point.y) < 2
  before = display()
  for type in [CGEventType.leftMouseDown, .leftMouseUp] {
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    event?.setIntegerValueField(.mouseEventClickState, value: 1)
    event?.post(tap: tap)
    usleep(120_000)
  }
  report("mouse click via post(\(label))", before)
  print("      (cursor verified on target: \(cursorOnTarget))")
}

// 4. The accessibility action, for contrast. Take the cursor reading here
//    rather than at start-up: the mouse tests above warped it, so comparing
//    against the original position would blame this action for their movement.
before = display()
let cursorBeforeAction = NSEvent.mouseLocation
let frontBeforeAction = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
let status = AXUIElementPerformAction(key, kAXPressAction as CFString)
report("AXUIElementPerformAction", before)
print("      (AXError \(status.rawValue)"
  + ", cursor moved: \(cursorBeforeAction != NSEvent.mouseLocation)"
  + ", focus stolen: \(frontBeforeAction != (NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")))")

CGWarpMouseCursorPosition(CGPoint(x: savedCursor.x, y: screenHeight - savedCursor.y))
print("\ncursor restored")
