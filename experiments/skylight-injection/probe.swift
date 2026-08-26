/// E1: can a mouse event be delivered to a background window without touching
/// the user's cursor?
///
/// Everything else in the desktop plan is downstream of this one answer. The
/// accessibility path already drives buttons in the background, but it has no
/// drag, and it cannot reach anything an application does not publish in its
/// tree. Freeform pointer control needs a synthesised mouse event that the
/// target accepts while it sits behind other windows.
///
/// A first attempt at this returned success from every call and changed
/// nothing, which is the signature of a malformed event rather than a rejected
/// one. Two concrete hypotheses came out of the shipping DoubaoWork binary
/// (`libaha_cua.dylib`), whose log format strings name the quantities it
/// carries per click:
///
///     mouse_click_on_window: pid, window_id, window_rect,
///                            window_local_position, global_position,
///                            button, click_count
///     synthetic_focus_acquire: failed to create focus events
///
///   H1  the event location must be window-local, not global — the binary
///       tracks both, so one of them is not the location field
///   H2  "focus events" is plural: one activation record per side is not
///       enough to put a background application into an input-accepting state
///
/// This probe crosses those two axes and reports which cell, if any, moves the
/// target. Verification is by reading the target's own state back through the
/// accessibility tree, never by trusting a return code — every channel tried
/// so far returned success while doing nothing.
///
/// Target is Calculator: launched in the background, its display is an
/// unambiguous witness, and pressing a digit is harmless.
///
///     swiftc -O probe.swift -o probe && open -g -a Calculator && ./probe

import AppKit
import ApplicationServices
import Foundation

// MARK: - Private symbols, resolved at run time

typealias SLEventPostToPidFn = @convention(c) (pid_t, CGEvent?) -> Int32
typealias SLPSPostEventRecordToFn = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>) -> Int32
typealias GetProcessForPIDFn = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32

let skylight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
guard let skylight else { print("SkyLight did not load: \(String(cString: dlerror()))"); exit(1) }
guard let postSym = dlsym(skylight, "SLEventPostToPid"),
      let recordSym = dlsym(skylight, "SLPSPostEventRecordTo") else {
  print("SkyLight is missing the symbols this depends on"); exit(1)
}
let slEventPostToPid = unsafeBitCast(postSym, to: SLEventPostToPidFn.self)
let slPSPostEventRecordTo = unsafeBitCast(recordSym, to: SLPSPostEventRecordToFn.self)

let appServices = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW)!
let getProcessForPID = unsafeBitCast(dlsym(appServices, "GetProcessForPID")!, to: GetProcessForPIDFn.self)

/// ProcessSerialNumber is two 32-bit halves; the API fills them in place.
func processSerialNumber(_ pid: pid_t) -> [UInt32]? {
  var psn = [UInt32](repeating: 0, count: 2)
  let ok = psn.withUnsafeMutableBytes { getProcessForPID(pid, $0.baseAddress!) } == 0
  return ok ? psn : nil
}

// MARK: - Accessibility, used only to observe

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
  print("launch it first:  open -g -a Calculator"); exit(1)
}
let pid = app.processIdentifier
let axApp = AXUIElementCreateApplication(pid)

/// The witness: whatever the calculator currently shows.
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

func digitFrame(_ label: String) -> CGRect? {
  var found: CGRect?
  func walk(_ element: AXUIElement, _ depth: Int) {
    if depth > 25 || found != nil { return }
    var title = stringAttribute(element, kAXTitleAttribute as String)
    if title.isEmpty { title = stringAttribute(element, kAXDescriptionAttribute as String) }
    if title == label, actionNames(element).contains(kAXPressAction as String) { found = frame(element) }
    for child in children(element) { walk(child, depth + 1) }
  }
  walk(axApp, 0)
  return found
}

guard let window = attribute(axApp, kAXFocusedWindowAttribute as String).map({ $0 as! AXUIElement })
  ?? (attribute(axApp, kAXWindowsAttribute as String) as? [AXUIElement])?.first else {
  print("no window"); exit(1)
}
guard let windowRect = frame(window), let keyRect = digitFrame("7") else {
  print("could not locate the window or the 7 key"); exit(1)
}

let onScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
let windowId = onScreen.first { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid }
  .flatMap { $0[kCGWindowNumber as String] as? UInt32 } ?? 0

let globalPoint = CGPoint(x: keyRect.midX, y: keyRect.midY)
let localPoint = CGPoint(x: globalPoint.x - windowRect.origin.x, y: globalPoint.y - windowRect.origin.y)

print("target       pid=\(pid) active=\(app.isActive) windowId=\(windowId)")
print("window rect  \(windowRect)")
print("key 7        global=(\(Int(globalPoint.x)), \(Int(globalPoint.y)))"
  + "  window-local=(\(Int(localPoint.x)), \(Int(localPoint.y)))\n")

// MARK: - H2: how many focus events

/// One AppKit activation record. The layout is the one yabai uses: a 248-byte
/// record whose 0x8a byte carries activate/deactivate and whose 0x3c word
/// carries the window id.
func activationRecord(_ psn: inout [UInt32], windowId: UInt32, activate: Bool) -> Int32 {
  var bytes = [UInt8](repeating: 0, count: 0xf8)
  bytes[0x04] = 0xf8
  bytes[0x08] = 0x0d
  bytes[0x8a] = activate ? 0x01 : 0x02
  var id = windowId
  withUnsafeBytes(of: &id) { source in for i in 0..<4 { bytes[0x3c + i] = source[i] } }
  return psn.withUnsafeMutableBytes { psnPointer in
    bytes.withUnsafeMutableBufferPointer { bytePointer in
      slPSPostEventRecordTo(psnPointer.baseAddress!, bytePointer.baseAddress!)
    }
  }
}

enum FocusStrategy: String, CaseIterable {
  /// Post nothing; test whether the event alone is enough.
  case none
  /// Deactivate the front application, then activate the target.
  case swap
  /// The swap, then a second activation for the target's specific window —
  /// the reading of "focus events" being plural.
  case swapThenWindow
}

func acquireFocus(_ strategy: FocusStrategy) -> String {
  guard strategy != .none else { return "skipped" }
  guard var targetPSN = processSerialNumber(pid) else { return "no target psn" }
  guard let front = NSWorkspace.shared.frontmostApplication,
        var frontPSN = processSerialNumber(front.processIdentifier) else { return "no front psn" }
  let frontWindow = onScreen.first { ($0[kCGWindowOwnerPID as String] as? pid_t) == front.processIdentifier }
    .flatMap { $0[kCGWindowNumber as String] as? UInt32 } ?? 0

  var codes: [Int32] = []
  codes.append(activationRecord(&frontPSN, windowId: frontWindow, activate: false))
  usleep(40_000)
  codes.append(activationRecord(&targetPSN, windowId: windowId, activate: true))
  usleep(40_000)
  if strategy == .swapThenWindow {
    codes.append(activationRecord(&targetPSN, windowId: windowId, activate: true))
    usleep(40_000)
  }
  return codes.map(String.init).joined(separator: ",")
}

func releaseFocus() {
  guard var targetPSN = processSerialNumber(pid),
        let front = NSWorkspace.shared.frontmostApplication,
        var frontPSN = processSerialNumber(front.processIdentifier) else { return }
  let frontWindow = onScreen.first { ($0[kCGWindowOwnerPID as String] as? pid_t) == front.processIdentifier }
    .flatMap { $0[kCGWindowNumber as String] as? UInt32 } ?? 0
  _ = activationRecord(&targetPSN, windowId: windowId, activate: false)
  usleep(30_000)
  _ = activationRecord(&frontPSN, windowId: frontWindow, activate: true)
}

// MARK: - H1: which coordinate space, and which fields

enum Placement: String, CaseIterable {
  /// Location in global display space, the obvious reading.
  case global
  /// Location in window-local space, on the theory that the private delivery
  /// path expects what the application will read as locationInWindow.
  case windowLocal
  /// Global location, plus the window identity fields filled in.
  case globalWithWindowFields
  /// Window-local location, plus the window identity fields.
  case localWithWindowFields
}

func buildEvent(_ type: CGEventType, _ placement: Placement) -> CGEvent? {
  let location: CGPoint
  switch placement {
  case .global, .globalWithWindowFields: location = globalPoint
  case .windowLocal, .localWithWindowFields: location = localPoint
  }
  guard let event = CGEvent(
    mouseEventSource: CGEventSource(stateID: .hidSystemState),
    mouseType: type, mouseCursorPosition: location, mouseButton: .left,
  ) else { return nil }
  event.setIntegerValueField(.mouseEventClickState, value: 1)
  event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
  if placement == .globalWithWindowFields || placement == .localWithWindowFields {
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowId))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowId))
  }
  return event
}

// MARK: - The matrix

struct Outcome {
  let focus: FocusStrategy
  let placement: Placement
  let focusCodes: String
  let moved: Bool
  let cursorMoved: Bool
  let focusStolen: Bool
}

var outcomes: [Outcome] = []
for focus in FocusStrategy.allCases {
  for placement in Placement.allCases {
    let before = display()
    let cursorBefore = NSEvent.mouseLocation
    let frontBefore = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""

    let codes = acquireFocus(focus)
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
      if let event = buildEvent(type, placement) { _ = slEventPostToPid(pid, event) }
      usleep(80_000)
    }
    Thread.sleep(forTimeInterval: 0.6)
    if focus != .none { releaseFocus() }
    Thread.sleep(forTimeInterval: 0.2)

    let after = display()
    outcomes.append(Outcome(
      focus: focus, placement: placement, focusCodes: codes,
      moved: before != after,
      cursorMoved: cursorBefore != NSEvent.mouseLocation,
      focusStolen: frontBefore != (NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""),
    ))
    print("  focus=\(focus.rawValue.padding(toLength: 15, withPad: " ", startingAt: 0))"
      + " place=\(placement.rawValue.padding(toLength: 23, withPad: " ", startingAt: 0))"
      + " \(before) -> \(after)"
      + "  DELIVERED=\(before != after)"
      + "  cursor=\(cursorBefore != NSEvent.mouseLocation)")
  }
}

let winners = outcomes.filter(\..moved)
print("\n\(winners.count) of \(outcomes.count) combinations delivered the click.")
for winner in winners {
  print("  focus=\(winner.focus.rawValue) placement=\(winner.placement.rawValue)"
    + " (focus codes \(winner.focusCodes))"
    + " cursor moved=\(winner.cursorMoved) focus stolen=\(winner.focusStolen)")
}
if winners.isEmpty {
  print("""

  None worked. That does not clear SkyLight: the shipping DoubaoWork binary
  calls exactly these two symbols, so the mechanism exists and this probe's
  event shape or focus sequence is still wrong. The next thing to vary is the
  activation record layout, which is assumed here rather than verified.
  """)
}
