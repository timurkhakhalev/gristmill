import AppKit
import ApplicationServices
import Darwin
import Foundation

// Research probe only. Reads Zoom; never clicks, focuses, or changes its windows.
// JSONL contains participant display names. Keep live output outside Git.
struct TileDescription: Equatable {
    let name: String
    let active: Bool
    let muted: Bool?
    let cameraOn: Bool
}

func parseTile(_ description: String) -> TileDescription? {
    var text = description
    let active = text.hasSuffix(", active speaker")
    if active { text.removeLast(", active speaker".count) }
    let cameraOn: Bool
    if text.hasSuffix(", Video on") {
        cameraOn = true
        text.removeLast(", Video on".count)
    } else if text.hasSuffix(", Video off") {
        cameraOn = false
        text.removeLast(", Video off".count)
    } else { return nil }
    let muted: Bool?
    if text.hasSuffix(", Computer audio muted") {
        muted = true
        text.removeLast(", Computer audio muted".count)
    } else if text.hasSuffix(", Computer audio unmuted") {
        muted = false
        text.removeLast(", Computer audio unmuted".count)
    } else if text.hasSuffix(", Telephone muted") {
        muted = true
        text.removeLast(", Telephone muted".count)
    } else if text.hasSuffix(", Telephone unmuted") {
        muted = false
        text.removeLast(", Telephone unmuted".count)
    } else if text.hasSuffix(", No audio connected") {
        muted = nil
        text.removeLast(", No audio connected".count)
    } else { return nil }
    guard !text.isEmpty else { return nil }
    return TileDescription(name: text, active: active, muted: muted, cameraOn: cameraOn)
}

if CommandLine.arguments.contains("--self-test") {
    precondition(parseTile("Our House Solano, CA, Computer audio unmuted, Video off, active speaker") ==
        TileDescription(name: "Our House Solano, CA", active: true, muted: false, cameraOn: false))
    precondition(parseTile("Video on, Computer audio muted, Video on") ==
        TileDescription(name: "Video on", active: false, muted: true, cameraOn: true))
    precondition(parseTile("A, Computer audio muted, Video off")?.active == false)
    precondition(parseTile("A, Video on, active speaker") == nil)
    precondition(parseTile("A, Computer audio unmuted, Video on, unknown status") == nil)
    precondition(parseTile(", Computer audio muted, Video on") == nil)
    precondition(parseTile("Call-In, User, Telephone muted, Video off") ==
        TileDescription(name: "Call-In, User", active: false, muted: true, cameraOn: false))
    precondition(parseTile("Call-In, Telephone unmuted, Video off, active speaker") ==
        TileDescription(name: "Call-In", active: true, muted: false, cameraOn: false))
    precondition(parseTile("A, No audio connected, Video on") ==
        TileDescription(name: "A", active: false, muted: nil, cameraOn: true))
    print("9 parser checks passed")
    exit(0)
}

func option(_ flag: String, default fallback: Double) -> Double {
    guard let index = CommandLine.arguments.firstIndex(of: flag), index + 1 < CommandLine.arguments.count,
          let value = Double(CommandLine.arguments[index + 1]), value.isFinite, value > 0 else { return fallback }
    return value
}
let duration = min(option("--seconds", default: 90), 600)
let interval = max(option("--interval", default: 0.5), 0.2)
var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
func hostNS() -> UInt64 {
    let ticks = mach_absolute_time()
    // Avoid UInt64 multiplication overflow on long machine uptime.
    return ticks / UInt64(timebase.denom) * UInt64(timebase.numer) +
        ticks % UInt64(timebase.denom) * UInt64(timebase.numer) / UInt64(timebase.denom)
}
func emit(_ data: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes)
    FileHandle.standardOutput.write(Data([10]))
}
func attribute(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (status, value)
}
func string(_ element: AXUIElement, _ name: String) -> String? { attribute(element, name).1 as? String }
func attributes(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    return AXUIElementCopyAttributeNames(element, &names) == .success ? names as? [String] ?? [] : []
}

guard AXIsProcessTrusted() else {
    emit(["type": "unavailable", "reason": "accessibility", "hostNS": String(hostNS())])
    exit(2)
}
guard let zoom = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "us.zoom.xos" }) else {
    emit(["type": "unavailable", "reason": "zoom-not-running"])
    exit(2)
}
let application = AXUIElementCreateApplication(zoom.processIdentifier)
AXUIElementSetMessagingTimeout(application, 0.1)
let probeID = UUID().uuidString
let notifications = ["AXValueChanged", "AXTitleChanged", "AXLayoutChanged", "AXUIElementDestroyed"]
var eventCounts: [String: Int] = [:]
var observer: AXObserver?
var tracked: [(element: AXUIElement, key: String)] = []
var serial = 0
let observerStatus = AXObserverCreate(zoom.processIdentifier, { _, element, notification, _ in
    let name = notification as String
    let key = tracked.first(where: { CFEqual($0.element, element) })?.key ?? "application"
    eventCounts[name, default: 0] += 1
    emit(["type": "event", "notification": name, "elementKey": key, "hostNS": String(hostNS())])
}, &observer)
if let observer { CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode) }

// Keys identify AX instances in this probe only, never Zoom accounts or meeting IDs.
func keyFor(_ element: AXUIElement, kind: String) -> String {
    if let old = tracked.first(where: { CFEqual($0.element, element) }) { return old.key }
    serial += 1
    let key = "\(kind)-\(serial)"
    tracked.append((element, key))
    var subscriptions: [String: Int32] = [:]
    if let observer {
        for name in notifications {
            subscriptions[name] = AXObserverAddNotification(observer, element, name as CFString, nil).rawValue
        }
    }
    emit(["type": "element", "elementKey": key, "attributes": attributes(element), "subscriptions": subscriptions,
          "hostNS": String(hostNS())])
    return key
}
emit(["type": "start", "probeID": probeID, "pid": zoom.processIdentifier, "intervalSeconds": interval,
      "durationSeconds": duration, "observerStatus": observerStatus.rawValue, "hostNS": String(hostNS()),
      "wallTime": ISO8601DateFormatter().string(from: Date()), "clock": "mach_absolute_time"])
_ = keyFor(application, kind: "application")
var reads = 0
var readMS: [Double] = []
var explicitReads = 0
var changes = 0
var lastSignature: String?
var activeKeys = Set<String>()
var namesByKey: [String: Set<String>] = [:]
var samplesByKey: [String: Int] = [:]
var unavailableReads = 0
let began = hostNS()
let cpuStart = clock()
var nextRead = began
while Double(hostNS() - began) / 1e9 < duration {
    let before = hostNS()
    var seen: [AXUIElement] = [application]
    let (windowStatus, rawWindows) = attribute(application, kAXWindowsAttribute)
    let windows = rawWindows as? [AXUIElement] ?? []
    var snapshots: [[String: Any]] = []
    var windowErrors: [[String: Any]] = []
    var signatureKeys: [String] = []
    var complete = windowStatus == .success && rawWindows is [AXUIElement]
    var explicit: [(String, String)] = []
    for window in windows {
        let (childrenStatus, rawChildren) = attribute(window, kAXChildrenAttribute)
        guard childrenStatus == .success, let children = rawChildren as? [AXUIElement] else {
            if childrenStatus != .noValue && childrenStatus != .attributeUnsupported {
                complete = false
                windowErrors.append(["status": childrenStatus.rawValue, "role": string(window, kAXRoleAttribute) ?? "unknown",
                                     "subrole": string(window, kAXSubroleAttribute) ?? "unknown"])
            }
            continue
        }
        let tiles = children.filter { string($0, kAXRoleAttribute) == "AXTabGroup" && string($0, kAXRoleDescriptionAttribute) == "Video render" }
        if tiles.isEmpty { continue }
        seen.append(window)
        let windowKey = keyFor(window, kind: "window")
        let subrole = string(window, kAXSubroleAttribute) ?? "unknown"
        let mode = subrole == "AXSystemDialog" ? "compact" : "full"
        var tileSamples: [[String: Any]] = []
        var windowActive: [String] = []
        for tile in tiles {
            seen.append(tile)
            AXUIElementSetMessagingTimeout(tile, 0.1)
            let key = keyFor(tile, kind: "tile")
            let (descriptionStatus, rawDescription) = attribute(tile, kAXDescriptionAttribute)
            let description = rawDescription as? String ?? ""
            let parsed = parseTile(description)
            if parsed == nil { complete = false }
            var item: [String: Any] = ["key": key, "description": description, "descriptionStatus": descriptionStatus.rawValue,
                                      "parsed": parsed != nil]
            if let parsed {
                item["displayName"] = parsed.name
                item["active"] = parsed.active
                item["muted"] = parsed.muted.map { $0 as Any } ?? NSNull()
                item["cameraOn"] = parsed.cameraOn
                namesByKey[key, default: []].insert(parsed.name)
                if parsed.active {
                    windowActive.append(key)
                    explicit.append((key, parsed.name))
                }
            }
            tileSamples.append(item)
        }
        // A compact tile without explicit activity remains an unverified video candidate.
        snapshots.append(["windowKey": windowKey, "mode": mode, "subrole": subrole, "tiles": tileSamples,
                          "activeKeys": windowActive, "basis": windowActive.isEmpty ? "none" : "explicit-marker"])
        signatureKeys.append("\(windowKey):\(mode):\(windowActive.sorted().joined(separator: ","))")
    }
    let after = hostNS()
    let elapsedMS = Double(after - before) / 1e6
    readMS.append(elapsedMS)
    reads += 1
    let usable = complete && explicit.count == 1
    if usable {
        explicitReads += 1
        activeKeys.insert(explicit[0].0)
        samplesByKey[explicit[0].0, default: 0] += 1
    }
    if !complete { unavailableReads += 1 }
    let signature = "\(complete):" + signatureKeys.sorted().joined(separator: "|")
    if let previous = lastSignature, previous != signature { changes += 1 }
    lastSignature = signature
    emit(["type": "read", "index": reads, "beforeHostNS": String(before), "afterHostNS": String(after),
          "readMS": elapsedMS, "complete": complete, "usableExplicit": usable,
          "state": !complete ? "unavailable" : explicit.isEmpty ? "unknown" : explicit.count == 1 ? "single" : "ambiguous",
          "windows": snapshots, "windowStatus": windowStatus.rawValue, "windowErrors": windowErrors])
    // Retire disappeared instances; returning after a gap creates a new key.
    let retired = tracked.filter { old in !seen.contains(where: { CFEqual($0, old.element) }) }
    for old in retired {
        if let observer { for name in notifications { AXObserverRemoveNotification(observer, old.element, name as CFString) } }
        emit(["type": "retired", "elementKey": old.key, "hostNS": String(hostNS())])
    }
    tracked.removeAll { old in retired.contains(where: { $0.key == old.key }) }
    nextRead += UInt64(interval * 1e9)
    if nextRead < hostNS() { nextRead = hostNS() }
    while true {
        let now = hostNS()
        if now >= nextRead || Double(now - began) / 1e9 >= duration { break }
        CFRunLoopRunInMode(.defaultMode, min(0.1, Double(nextRead - now) / 1e9), false)
    }
}
if let observer {
    for old in tracked { for name in notifications { AXObserverRemoveNotification(observer, old.element, name as CFString) } }
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
}
let sorted = readMS.sorted()
let elapsed = Double(hostNS() - began) / 1e9
let cpuSeconds = Double(clock() - cpuStart) / Double(CLOCKS_PER_SEC)
emit(["type": "summary", "reads": reads, "elapsedSeconds": elapsed, "cpuSeconds": cpuSeconds,
      "cpuPercentOneCore": cpuSeconds / elapsed * 100, "explicitSingleReads": explicitReads,
      "unavailableReads": unavailableReads, "activeAXInstanceCount": activeKeys.count, "activityChanges": changes,
      "readMedianMS": sorted.isEmpty ? 0 : sorted[sorted.count / 2],
      "readP95MS": sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))],
      "events": eventCounts, "samplesByKey": samplesByKey,
      "renamedInstanceCount": namesByKey.values.filter { $0.count > 1 }.count])
