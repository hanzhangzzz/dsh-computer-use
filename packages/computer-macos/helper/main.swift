/// dsh-computer-macos helper: the only part of the plugin that talks to macOS.
///
/// Speaks NDJSON over stdin/stdout — one request per line, one response per
/// line. stdio rather than a localhost port on purpose: the process lifetime is
/// tied to the pipe, so when the plugin's fiber disposes there is nothing left
/// listening and nothing to leak, and there is no unauthenticated local port to
/// defend.
///
/// It is deliberately mechanical. Allow-lists, retries, and anything resembling
/// a decision live on the Node side, where they are configurable and testable.
/// This binary reads the accessibility tree and performs accessibility actions.
///
/// Uses public APIs only. Codex reaches for SkyLight's private
/// SLEventPostToPid because it synthesises mouse events at screen coordinates;
/// driving AXPress directly needs none of that, and measurably does not move
/// the user's cursor or steal focus (see experiments/macos-ax-probe).
///
/// Build: swiftc -O main.swift -o dsh-computer-macos-helper

import AppKit
import ApplicationServices
import Foundation

// MARK: - Accessibility reading

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ key: String) -> String {
  (attribute(element, key) as? String) ?? ""
}

func boolAttribute(_ element: AXUIElement, _ key: String) -> Bool? {
  attribute(element, key) as? Bool
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func actionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return (names as? [String]) ?? []
}

/// Accessible name, in the order a screen reader would prefer. Mirrors the
/// browser provider's name resolution so both surfaces read the same way to
/// the model.
func accessibleName(_ element: AXUIElement) -> String {
  for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] as [String] {
    let value = stringAttribute(element, key)
    if !value.isEmpty { return value }
  }
  // A button whose label is a child static text: common in toolbars.
  for child in children(element) where stringAttribute(child, kAXRoleAttribute as String) == "AXStaticText" {
    let value = stringAttribute(child, kAXValueAttribute as String)
    if !value.isEmpty { return value }
  }
  return ""
}

func frame(_ element: AXUIElement) -> CGRect? {
  guard let value = attribute(element, "AXFrame") else { return nil }
  var rect = CGRect.zero
  // AXValue of type CGRect; AXValueGetValue fills it or reports the mismatch.
  guard AXValueGetValue(value as! AXValue, .cgRect, &rect) else { return nil }
  return rect
}

/// One enumerated element as the model sees it.
struct Node {
  let element: AXUIElement
  let index: Int
  let role: String
  let name: String
  let rect: CGRect?
  let actions: [String]
}

let ACTIONABLE = Set([
  kAXPressAction as String,
  kAXConfirmAction as String,
  kAXIncrementAction as String,
  kAXDecrementAction as String,
  "AXOpen",
])

/// Roles that accept text even when they expose no action.
let EDITABLE_ROLES = Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"])

/// Depth-first enumeration in a fixed order. Order is the contract: the model
/// addresses elements by position in this list, so `snapshot` and `press` must
/// walk identically or indices mean different things to each.
func enumerate(_ root: AXUIElement, cap: Int = 500, maxDepth: Int = 30) -> [Node] {
  var nodes: [Node] = []

  func visit(_ element: AXUIElement, _ depth: Int) {
    if nodes.count >= cap || depth > maxDepth { return }
    let role = stringAttribute(element, kAXRoleAttribute as String)
    let actions = actionNames(element)
    let editable = EDITABLE_ROLES.contains(role)
    let enabled = boolAttribute(element, kAXEnabledAttribute as String) ?? true
    let box = frame(element)
    // Skip zero-sized and disabled controls: the model cannot act on them and
    // every one it tries costs a round trip.
    let usable = enabled && (box == nil || (box!.width >= 1 && box!.height >= 1))
    if usable && (!actions.filter({ ACTIONABLE.contains($0) }).isEmpty || editable) {
      nodes.append(Node(
        element: element,
        index: nodes.count,
        role: role,
        name: accessibleName(element),
        rect: box,
        actions: actions,
      ))
    }
    for child in children(element) { visit(child, depth + 1) }
  }

  visit(root, 0)
  return nodes
}

// MARK: - The invariant, checked at runtime

/// Focus and cursor must survive every action. This is the co-driving promise
/// in executable form: rather than trusting that AXPress is non-intrusive, each
/// action reports whether it disturbed anything, and the Node side treats a
/// true here as a defect rather than passing it over in silence.
struct Undisturbed {
  let frontmost: String
  let cursor: NSPoint

  static func capture() -> Undisturbed {
    Undisturbed(
      frontmost: NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "",
      cursor: NSEvent.mouseLocation,
    )
  }

  func check() -> (focusStolen: Bool, cursorMoved: Bool) {
    let now = Undisturbed.capture()
    return (frontmost != now.frontmost, cursor != now.cursor)
  }
}

// MARK: - Application lookup

func runningApp(_ bundleId: String) -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
}

/// Apps already told to expose their tree; asking twice is harmless but the
/// settle wait is not free.
var accessibilityEnabled = Set<pid_t>()

/// Chromium builds its accessibility tree only once it believes an assistive
/// client is watching, so an Electron app looks empty to a fresh reader: the
/// WeChat devtools reported 0 actionable nodes in its window while its menu bar
/// showed 85. Setting AXManualAccessibility is Chromium's documented way to say
/// "expose it anyway" — a public attribute, not a private symbol — and it took
/// that same window from 0 to 13.
///
/// This matters beyond one app: most desktop software worth automating is
/// Electron, and without this the whole class reads as empty.
func enableAccessibility(_ axApp: AXUIElement, _ pid: pid_t) {
  if accessibilityEnabled.contains(pid) { return }
  accessibilityEnabled.insert(pid)
  guard AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success else {
    // Native apps reject the attribute and need no such coaxing.
    return
  }
  // The tree is built asynchronously; reading immediately still sees nothing.
  Thread.sleep(forTimeInterval: 1.0)
}

/// The window a snapshot describes. Prefers the app's focused window; falls
/// back to its first window. Never the whole screen — at the model's image
/// budget a full-screen capture shrinks a 20px control to about 5px.
func targetWindow(_ axApp: AXUIElement) -> AXUIElement? {
  if let focused = attribute(axApp, kAXFocusedWindowAttribute as String) {
    return (focused as! AXUIElement)
  }
  return (attribute(axApp, kAXWindowsAttribute as String) as? [AXUIElement])?.first
}

// MARK: - Request handling

struct Request: Decodable {
  let id: Int
  let method: String
  let params: Params?

  struct Params: Decodable {
    let bundleId: String?
    let index: Int?
    let x: Double?
    let y: Double?
    let width: Double?
    let height: Double?
    let action: String?
    let text: String?
    let key: String?
    let modifiers: [String]?
    // Identity the caller believes it is acting on. The action is refused when
    // it no longer matches, so a tree that changed between snapshot and action
    // cannot produce a wrong click that is only noticed afterwards.
    let expectRole: String?
    let expectName: String?
  }
}

func respond(_ id: Int, _ payload: [String: Any]) {
  var body = payload
  body["id"] = id
  guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.withoutEscapingSlashes]),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func fail(_ id: Int, _ message: String, code: String = "MACOS_HELPER_ERROR") {
  respond(id, ["error": ["code": code, "message": message]])
}

/// Cache the last enumeration per app so an action can verify identity without
/// paying for a second full walk (VS Code's tree costs over a second).
var lastEnumeration: [String: [Node]] = [:]

func handleSurfaces(_ id: Int) {
  let apps = NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }
    .sorted { ($0.bundleIdentifier ?? "") < ($1.bundleIdentifier ?? "") }
  let payload = apps.map { app -> [String: Any] in
    [
      "bundleId": app.bundleIdentifier ?? "",
      "pid": app.processIdentifier,
      "title": app.localizedName ?? "",
      "active": app.isActive,
    ]
  }
  respond(id, ["result": ["surfaces": payload]])
}

func handleSnapshot(_ id: Int, _ bundleId: String) {
  guard let app = runningApp(bundleId) else {
    return fail(id, "application \(bundleId) is not running", code: "MACOS_APP_NOT_RUNNING")
  }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  enableAccessibility(axApp, app.processIdentifier)
  guard let window = targetWindow(axApp) else {
    return fail(id, "application \(bundleId) has no window to drive", code: "MACOS_NO_WINDOW")
  }
  let nodes = enumerate(window)
  lastEnumeration[bundleId] = nodes
  let elements = nodes.map { node -> [String: Any] in
    var entry: [String: Any] = ["index": node.index, "role": node.role, "name": node.name]
    if let rect = node.rect {
      entry["rect"] = ["x": rect.origin.x, "y": rect.origin.y, "width": rect.size.width, "height": rect.size.height]
    }
    entry["editable"] = EDITABLE_ROLES.contains(node.role)
    // Report the vocabulary this element actually offers: without it the model
    // cannot know that a stepper takes AXIncrement or that a toolbar item
    // publishes its own reorder action.
    entry["actions"] = node.actions
    return entry
  }
  respond(id, ["result": [
    "title": stringAttribute(window, kAXTitleAttribute as String),
    "bundleId": bundleId,
    "elements": elements,
  ]])
}

/// Outcome of resolving an index: either the live node or why it cannot be used.
enum Resolved {
  case success(Node)
  case failure(String)
}

/// Resolve an index against the cached enumeration and check it still is what
/// the caller thinks. Re-walks when there is no cache.
func resolve(_ bundleId: String, _ index: Int, _ expectRole: String?, _ expectName: String?) -> Resolved {
  var nodes = lastEnumeration[bundleId] ?? []
  if nodes.isEmpty {
    guard let app = runningApp(bundleId) else { return .failure("application \(bundleId) is not running") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableAccessibility(axApp, app.processIdentifier)
    guard let window = targetWindow(axApp) else {
      return .failure("application \(bundleId) has no window to drive")
    }
    nodes = enumerate(window)
    lastEnumeration[bundleId] = nodes
  }
  guard index >= 0 && index < nodes.count else {
    return .failure("no element at index \(index); take a fresh snapshot")
  }
  let node = nodes[index]
  // Re-read the live element rather than trusting the cached projection: the
  // tree may have changed since, which is exactly the case worth catching.
  let liveRole = stringAttribute(node.element, kAXRoleAttribute as String)
  let liveName = accessibleName(node.element)
  if let role = expectRole, role != liveRole {
    return .failure("element \(index) is now \(liveRole) \"\(liveName)\", not \(role); take a fresh snapshot")
  }
  if let name = expectName, name != liveName {
    return .failure("element \(index) is now \(liveRole) \"\(liveName)\", not \"\(name)\"; take a fresh snapshot")
  }
  return .success(node)
}

func handlePress(_ id: Int, _ params: Request.Params) {
  guard let bundleId = params.bundleId, let index = params.index else {
    return fail(id, "press requires bundleId and index")
  }
  switch resolve(bundleId, index, params.expectRole, params.expectName) {
  case .failure(let message):
    fail(id, message, code: "MACOS_STALE_INDEX")
  case .success(let node):
    let before = Undisturbed.capture()
    let action = node.actions.contains(kAXPressAction as String)
      ? kAXPressAction as String
      : (node.actions.first { ACTIONABLE.contains($0) } ?? kAXPressAction as String)
    let status = AXUIElementPerformAction(node.element, action as CFString)
    // Let the target repaint before the caller asks for the next snapshot.
    Thread.sleep(forTimeInterval: 0.25)
    lastEnumeration[bundleId] = nil
    let disturbed = before.check()
    guard status == .success else {
      return fail(id, "\(action) on \(node.role) \"\(node.name)\" failed with AXError \(status.rawValue)", code: "MACOS_ACTION_FAILED")
    }
    respond(id, ["result": [
      "acted": "\(node.role) \"\(node.name)\"",
      "action": action,
      "focusStolen": disturbed.focusStolen,
      "cursorMoved": disturbed.cursorMoved,
    ]])
  }
}

/// Walk up to the nearest ancestor that can actually be acted on. A hit test
/// often lands on a label or an image inside the control rather than the
/// control: pointing at "导入" returns the AXStaticText, whose only actions are
/// AXShowMenu and AXScrollToVisible.
func actionableAncestor(_ element: AXUIElement, within limit: Int = 6) -> AXUIElement? {
  var current: AXUIElement? = element
  var steps = 0
  while let node = current, steps < limit {
    if !actionNames(node).filter({ ACTIONABLE.contains($0) }).isEmpty { return node }
    current = (attribute(node, kAXParentAttribute as String)).map { $0 as! AXUIElement }
    steps += 1
  }
  return nil
}

/// Press whatever sits at a screen coordinate.
///
/// The coordinate is resolved through AXUIElementCopyElementAtPosition — a
/// public hit test — and the resulting element is pressed through the same
/// accessibility action as any other. Nothing is synthesised, so this keeps the
/// promise the whole desktop path is built on: the user's cursor and focus are
/// untouched.
///
/// It also makes a coordinate click checkable before it happens, which a
/// synthesised mouse event can never be. The caller learns what the point
/// resolved to, and may pass expectName to have a mismatch refused rather than
/// discovered afterwards. That is the failure from 2026-08-26, where a blind
/// coordinate click aimed at a nav item and hit the window's close button.
func handlePressAt(_ id: Int, _ params: Request.Params) {
  guard let bundleId = params.bundleId, let x = params.x, let y = params.y else {
    return fail(id, "pressAt requires bundleId, x and y")
  }
  guard let app = runningApp(bundleId) else {
    return fail(id, "application \(bundleId) is not running", code: "MACOS_APP_NOT_RUNNING")
  }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  enableAccessibility(axApp, app.processIdentifier)

  var hit: AXUIElement?
  let status = AXUIElementCopyElementAtPosition(axApp, Float(x), Float(y), &hit)
  guard status == .success, let landed = hit else {
    return fail(id, "nothing accessible at (\(Int(x)), \(Int(y))) in \(bundleId)", code: "MACOS_NO_ELEMENT_AT_POINT")
  }
  let landedRole = stringAttribute(landed, kAXRoleAttribute as String)
  let landedName = accessibleName(landed)

  guard let target = actionableAncestor(landed) else {
    return fail(
      id,
      "(\(Int(x)), \(Int(y))) resolves to \(landedRole) \"\(landedName)\", which exposes no action; aim at a control or use an index from the snapshot",
      code: "MACOS_NOT_ACTIONABLE",
    )
  }
  let targetRole = stringAttribute(target, kAXRoleAttribute as String)
  let targetName = accessibleName(target)
  if let expected = params.expectName, expected != targetName {
    return fail(
      id,
      "(\(Int(x)), \(Int(y))) resolves to \(targetRole) \"\(targetName)\", not \"\(expected)\"; nothing was pressed",
      code: "MACOS_POINT_MISMATCH",
    )
  }

  let before = Undisturbed.capture()
  let pressed = AXUIElementPerformAction(target, kAXPressAction as CFString)
  Thread.sleep(forTimeInterval: 0.25)
  lastEnumeration[bundleId] = nil
  let disturbed = before.check()
  guard pressed == .success else {
    return fail(id, "pressing \(targetRole) \"\(targetName)\" failed with AXError \(pressed.rawValue)", code: "MACOS_ACTION_FAILED")
  }
  respond(id, ["result": [
    "acted": "\(targetRole) \"\(targetName)\"",
    "resolvedFrom": "\(landedRole) \"\(landedName)\"",
    "focusStolen": disturbed.focusStolen,
    "cursorMoved": disturbed.cursorMoved,
  ]])
}

/// Perform a named action on an enumerated element.
///
/// There is no drag action in the accessibility vocabulary — enumerating every
/// action three real applications expose gives AXPress, AXShowMenu, AXPick,
/// AXIncrement, AXDecrement, AXCancel, AXDelete, AXOpen, AXRaise, AXZoomWindow,
/// AXScrollToVisible and the AXScroll*ByPage family, and nothing that drags.
///
/// What that vocabulary does contain is the outcome of many drags, exposed
/// directly: a stepper offers AXIncrement instead of dragging its slider, a
/// context menu offers AXShowMenu instead of a right-drag, and applications may
/// publish their own — Finder's toolbar advertises 移到上一项 ("move to previous
/// item"), which is a reorder without a pointer. This method is how the model
/// reaches those, since the snapshot already reports each element's actions.
func handleAction(_ id: Int, _ params: Request.Params) {
  guard let bundleId = params.bundleId, let index = params.index, let action = params.action else {
    return fail(id, "action requires bundleId, index and action")
  }
  switch resolve(bundleId, index, params.expectRole, params.expectName) {
  case .failure(let message):
    fail(id, message, code: "MACOS_STALE_INDEX")
  case .success(let node):
    let available = actionNames(node.element)
    guard available.contains(action) else {
      return fail(
        id,
        "\(node.role) \"\(node.name)\" offers \(available.joined(separator: ", ")); it has no \(action)",
        code: "MACOS_NO_SUCH_ACTION",
      )
    }
    let before = Undisturbed.capture()
    let status = AXUIElementPerformAction(node.element, action as CFString)
    Thread.sleep(forTimeInterval: 0.25)
    lastEnumeration[bundleId] = nil
    let disturbed = before.check()
    guard status == .success else {
      return fail(id, "\(action) on \(node.role) \"\(node.name)\" failed with AXError \(status.rawValue)", code: "MACOS_ACTION_FAILED")
    }
    respond(id, ["result": [
      "acted": "\(node.role) \"\(node.name)\"",
      "action": action,
      "focusStolen": disturbed.focusStolen,
      "cursorMoved": disturbed.cursorMoved,
    ]])
  }
}

/// Move or resize a window by writing its position and size.
///
/// This is the one drag that needs no pointer at all: AXPosition and AXSize are
/// writable, so dragging a title bar and hauling a resize corner both reduce to
/// setting an attribute. Verified moving a background window and putting it
/// back with the cursor and focus untouched.
func handleWindow(_ id: Int, _ params: Request.Params) {
  guard let bundleId = params.bundleId else { return fail(id, "window requires bundleId") }
  guard let app = runningApp(bundleId) else {
    return fail(id, "application \(bundleId) is not running", code: "MACOS_APP_NOT_RUNNING")
  }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  guard let window = targetWindow(axApp) else {
    return fail(id, "application \(bundleId) has no window", code: "MACOS_NO_WINDOW")
  }
  let before = Undisturbed.capture()
  if let x = params.x, let y = params.y {
    var point = CGPoint(x: x, y: y)
    guard let value = AXValueCreate(.cgPoint, &point),
          AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value) == .success else {
      return fail(id, "this window refused to move", code: "MACOS_ACTION_FAILED")
    }
  }
  if let width = params.width, let height = params.height {
    var size = CGSize(width: width, height: height)
    guard let value = AXValueCreate(.cgSize, &size),
          AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) == .success else {
      return fail(id, "this window refused to resize", code: "MACOS_ACTION_FAILED")
    }
  }
  Thread.sleep(forTimeInterval: 0.2)
  var origin = CGPoint.zero
  if let value = attribute(window, kAXPositionAttribute as String) {
    AXValueGetValue(value as! AXValue, .cgPoint, &origin)
  }
  var extent = CGSize.zero
  if let value = attribute(window, kAXSizeAttribute as String) {
    AXValueGetValue(value as! AXValue, .cgSize, &extent)
  }
  let disturbed = before.check()
  respond(id, ["result": [
    "title": stringAttribute(window, kAXTitleAttribute as String),
    "x": origin.x, "y": origin.y, "width": extent.width, "height": extent.height,
    "focusStolen": disturbed.focusStolen,
    "cursorMoved": disturbed.cursorMoved,
  ]])
}

func handleSetValue(_ id: Int, _ params: Request.Params) {
  guard let bundleId = params.bundleId, let index = params.index, let text = params.text else {
    return fail(id, "setValue requires bundleId, index and text")
  }
  switch resolve(bundleId, index, params.expectRole, params.expectName) {
  case .failure(let message):
    fail(id, message, code: "MACOS_STALE_INDEX")
  case .success(let node):
    let before = Undisturbed.capture()
    let status = AXUIElementSetAttributeValue(node.element, kAXValueAttribute as CFString, text as CFTypeRef)
    Thread.sleep(forTimeInterval: 0.15)
    lastEnumeration[bundleId] = nil
    let disturbed = before.check()
    guard status == .success else {
      return fail(id, "setting the value of \(node.role) \"\(node.name)\" failed with AXError \(status.rawValue)", code: "MACOS_ACTION_FAILED")
    }
    respond(id, ["result": [
      "filled": "\(node.role) \"\(node.name)\"",
      "text": text,
      "focusStolen": disturbed.focusStolen,
      "cursorMoved": disturbed.cursorMoved,
    ]])
  }
}

func handlePermissions(_ id: Int) {
  respond(id, ["result": [
    "accessibility": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
  ]])
}

// MARK: - Loop

let decoder = JSONDecoder()
while let line = readLine(strippingNewline: true) {
  if line.isEmpty { continue }
  guard let data = line.data(using: .utf8), let request = try? decoder.decode(Request.self, from: data) else {
    respond(0, ["error": ["code": "MACOS_BAD_REQUEST", "message": "could not parse request line"]])
    continue
  }
  let params = request.params ?? Request.Params(
    bundleId: nil, index: nil, x: nil, y: nil, width: nil, height: nil, action: nil,
    text: nil, key: nil, modifiers: nil, expectRole: nil, expectName: nil,
  )
  switch request.method {
  case "permissions": handlePermissions(request.id)
  case "surfaces": handleSurfaces(request.id)
  case "snapshot":
    guard let bundleId = params.bundleId else { fail(request.id, "snapshot requires bundleId"); break }
    handleSnapshot(request.id, bundleId)
  case "press": handlePress(request.id, params)
  case "pressAt": handlePressAt(request.id, params)
  case "action": handleAction(request.id, params)
  case "window": handleWindow(request.id, params)
  case "setValue": handleSetValue(request.id, params)
  default: fail(request.id, "unknown method \(request.method)", code: "MACOS_UNKNOWN_METHOD")
  }
}
