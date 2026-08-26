/// Reproducible probe for the macOS Accessibility path behind the planned
/// desktop provider (docs/desktop-control-plan.md). It answers one question the
/// whole plan rests on: can we read and *act on* a background application
/// through public APIs only, without stealing focus or moving the user's cursor?
///
/// Build and run (no Xcode needed, Command Line Tools suffice):
///     swiftc -O probe.swift -o probe
///     ./probe apps                          # running apps + permission state
///     ./probe walk com.apple.calculator     # pressable AX nodes, background
///     ./probe press com.apple.calculator 7  # press one button, background
///
/// Requires Accessibility permission for whichever process runs it (the
/// terminal, when run this way). `./probe apps` reports whether it is granted;
/// it never prompts. Nothing here uses a private API.

import AppKit
import ApplicationServices
import Foundation

// MARK: - AX reading helpers

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

/// Accessible name, in the order a screen reader would prefer.
func accessibleName(_ element: AXUIElement) -> String {
  let title = stringAttribute(element, kAXTitleAttribute as String)
  if !title.isEmpty { return title }
  let description = stringAttribute(element, kAXDescriptionAttribute as String)
  if !description.isEmpty { return description }
  return (attribute(element, kAXValueAttribute as String) as? String) ?? ""
}

struct Node {
  let element: AXUIElement
  let role: String
  let name: String
  let depth: Int
}

/// Non-empty static text in a subtree — how the probe reads back whether an
/// action actually took effect, rather than trusting the AXError alone.
func collectText(_ element: AXUIElement, depth: Int = 0, into texts: inout [String]) {
  if depth > 25 || texts.count >= 20 { return }
  if stringAttribute(element, kAXRoleAttribute as String) == "AXStaticText" {
    let value = (attribute(element, kAXValueAttribute as String) as? String) ?? ""
    if !value.isEmpty { texts.append(value) }
  }
  for child in children(element) { collectText(child, depth: depth + 1, into: &texts) }
}

/// Depth-first walk collecting nodes that expose an AXPress action — the
/// desktop analogue of the DOM interactive-element enumeration the Playwright
/// provider already does. `cap` and `maxDepth` bound pathological trees.
func collectPressable(
  _ element: AXUIElement,
  depth: Int = 0,
  maxDepth: Int = 25,
  cap: Int = 4000,
  into nodes: inout [Node],
) {
  if nodes.count >= cap || depth > maxDepth { return }
  if actionNames(element).contains(kAXPressAction as String) {
    nodes.append(Node(
      element: element,
      role: stringAttribute(element, kAXRoleAttribute as String),
      name: accessibleName(element),
      depth: depth,
    ))
  }
  for child in children(element) {
    collectPressable(child, depth: depth + 1, maxDepth: maxDepth, cap: cap, into: &nodes)
  }
}

// MARK: - Observation of the invariants under test

/// The two things a background action must never disturb.
struct Undisturbed {
  let frontmost: String
  let cursor: NSPoint

  static func capture() -> Undisturbed {
    Undisturbed(
      frontmost: NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?",
      cursor: NSEvent.mouseLocation,
    )
  }

  func report() {
    let now = Undisturbed.capture()
    print("focus stolen: \(frontmost != now.frontmost)  (\(frontmost) -> \(now.frontmost))")
    print("cursor moved:  \(cursor != now.cursor)")
  }
}

func runningApp(_ bundleId: String) -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
}

// MARK: - Commands

func commandApps() {
  // AXIsProcessTrusted does not prompt; AXIsProcessTrustedWithOptions would.
  print("accessibility trusted: \(AXIsProcessTrusted())")
  print("screen recording:      \(CGPreflightScreenCaptureAccess())")
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  print("regular running apps: \(apps.count)")
  for app in apps {
    print("  pid=\(app.processIdentifier) active=\(app.isActive) \(app.bundleIdentifier ?? "?") — \(app.localizedName ?? "?")")
  }
}

func commandWalk(_ bundleId: String) {
  guard let app = runningApp(bundleId) else { print("not running: \(bundleId)"); return }
  let before = Undisturbed.capture()
  print("target=\(bundleId) pid=\(app.processIdentifier) active=\(app.isActive) hidden=\(app.isHidden)")

  let started = Date()
  var nodes: [Node] = []
  collectPressable(AXUIElementCreateApplication(app.processIdentifier), into: &nodes)
  let ms = Int(Date().timeIntervalSince(started) * 1000)

  print("pressable nodes: \(nodes.count)  (walk \(ms)ms)")
  for node in nodes.prefix(20) { print("   d\(node.depth) \(node.role) \"\(node.name)\"") }
  before.report()
}

func commandPress(_ bundleId: String, _ names: [String]) {
  guard let app = runningApp(bundleId) else { print("not running: \(bundleId)"); return }
  let before = Undisturbed.capture()
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  print("target=\(bundleId) pid=\(app.processIdentifier) active=\(app.isActive)")

  for name in names {
    var nodes: [Node] = []
    collectPressable(axApp, into: &nodes)
    guard let hit = nodes.first(where: { $0.name == name }) else {
      print("press \"\(name)\" -> no such pressable node")
      continue
    }
    let started = Date()
    let status = AXUIElementPerformAction(hit.element, kAXPressAction as CFString)
    let ms = Int(Date().timeIntervalSince(started) * 1000)
    print("press \"\(name)\" -> \(status == .success ? "success" : "error \(status.rawValue)") (\(ms)ms)")
    Thread.sleep(forTimeInterval: 0.25)
  }

  var texts: [String] = []
  collectText(axApp, into: &texts)
  print("static text after actions: \(texts.prefix(4))")
  print("target still inactive: \(!(runningApp(bundleId)?.isActive ?? true))")
  before.report()
}

// MARK: - Entry

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "apps", nil:
  commandApps()
case "walk" where arguments.count >= 2:
  commandWalk(arguments[1])
case "press" where arguments.count >= 3:
  commandPress(arguments[1], Array(arguments.dropFirst(2)))
default:
  print("usage: probe apps | probe walk <bundle-id> | probe press <bundle-id> <name>...")
}
