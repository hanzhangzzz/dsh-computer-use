/// How long the user has left the machine alone, in seconds.
///
/// Exists to replace a blanket ban with a measured condition. Some experiments
/// this project needs — anything that posts activation records or synthesises
/// pointer events — briefly take focus or move the cursor. Running them while
/// someone is typing swallows a keystroke; running them at 3am costs nothing.
/// An unattended loop could not tell those apart, so the rule became "never",
/// which put the one task that decides whether the whole goal is reachable out
/// of reach.
///
/// `CGEventSource.secondsSinceLastEventType` is public and reports per input
/// kind, so the minimum across mouse, keyboard and scroll is the honest answer
/// to "is anyone there".
///
///     swiftc -O idle.swift -o idle
///     ./idle          # prints seconds, e.g. 51.0
///     ./idle 300      # exits 0 if idle at least that long, else 1
///
/// The exit-code form is the one a script wants:
///
///     ./idle 300 && ./disruptive-probe

import CoreGraphics
import Foundation

let watched: [CGEventType] = [.mouseMoved, .keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel]

let idleSeconds = watched
  .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
  .min() ?? 0

guard let requirement = CommandLine.arguments.dropFirst().first else {
  print(String(format: "%.1f", idleSeconds))
  exit(0)
}

guard let threshold = Double(requirement) else {
  FileHandle.standardError.write("usage: idle [seconds-required]\n".data(using: .utf8)!)
  exit(2)
}

if idleSeconds >= threshold {
  print(String(format: "idle %.0fs, threshold %.0fs — clear to run", idleSeconds, threshold))
  exit(0)
}
print(String(format: "idle %.0fs, threshold %.0fs — someone is here, skip", idleSeconds, threshold))
exit(1)
