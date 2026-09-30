import AppKit
import ApplicationServices
import CryptoKit
import Foundation


func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement]? {
    guard let value = attribute(element, name) else { return nil }
    return value as? [AXUIElement]
}

func string(_ element: AXUIElement, _ name: String) -> String? {
    attribute(element, name) as? String
}

func visible(_ element: AXUIElement) -> Bool {
    if (attribute(element, kAXHiddenAttribute) as? Bool) == true { return false }
    guard let position = attribute(element, kAXPositionAttribute),
          let size = attribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(),
          CFGetTypeID(size) == AXValueGetTypeID() else { return false }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    return AXValueGetValue(position as! AXValue, .cgPoint, &point)
        && AXValueGetValue(size as! AXValue, .cgSize, &dimensions)
        && dimensions.width > 0 && dimensions.height > 0
}

func walk(_ root: AXUIElement, limit: Int = 900) -> ([AXUIElement], Bool) {
    var pending = [root]
    var nodes: [AXUIElement] = []
    while let node = pending.popLast() {
        nodes.append(node)
        if nodes.count > limit { return (nodes, false) }
        var rawChildren: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &rawChildren)
        if status == .success {
            guard let children = rawChildren as? [AXUIElement] else { return (nodes, false) }
            pending.append(contentsOf: children)
        } else if status != .noValue && status != .attributeUnsupported {
            return (nodes, false)
        }
    }
    return (nodes, true)
}

func hasMeetLeaveButton(_ root: AXUIElement) -> Bool? {
    let (nodes, complete) = walk(root)
    guard complete else { return nil }
    return nodes.contains { node in
        guard string(node, kAXRoleAttribute) == "AXButton",
              (attribute(node, kAXEnabledAttribute) as? Bool) != false,
              visible(node) else { return false }
        // Meet exposes no stable AX identifier for this button; its DOM class is available in AX.
        return (attribute(node, "AXDOMClassList") as? [String])?.contains("xCYCgd") == true
    }
}

func hasZoomMeetingWindow(_ window: AXUIElement) -> Bool? {
    guard let children = elements(window, kAXChildrenAttribute) else { return nil }
    var defaultButton: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(window, kAXDefaultButtonAttribute as CFString, &defaultButton)
    guard status == .success || status == .noValue || status == .attributeUnsupported else { return nil }
    // Zoom's preview has a default Join button; a joined call keeps its video tab when controls hide.
    // The compact in-call window uses AXSystemDialog after the main call window is minimized.
    return ["AXStandardWindow", "AXSystemDialog"].contains(string(window, kAXSubroleAttribute) ?? "")
        && defaultButton == nil
        && children.contains { string($0, kAXRoleAttribute) == "AXTabGroup" }
}

func focusedWebArea(_ application: AXUIElement, window: AXUIElement) -> AXUIElement? {
    if let focused = attribute(application, kAXFocusedUIElementAttribute) {
        var node = focused as! AXUIElement
        var area: AXUIElement?
        for _ in 0..<18 {
            if string(node, kAXRoleAttribute) == "AXWebArea" { area = node }
            if CFEqual(node, window) { return area }
            guard let parent = attribute(node, kAXParentAttribute) else { break }
            node = parent as! AXUIElement
        }
    }
    let (nodes, complete) = walk(window)
    guard complete else { return nil }
    let areas = nodes.filter { string($0, kAXRoleAttribute) == "AXWebArea" && visible($0) }
    return areas.count == 1 ? areas[0] : nil
}

func meetingKey(_ url: URL) -> String {
    let room = "\(url.host ?? "")\(url.path)".lowercased()
    return SHA256.hash(data: Data(room.utf8)).map { String(format: "%02x", $0) }.joined()
}

func webURL(_ element: AXUIElement) -> URL? {
    guard let value = attribute(element, "AXURL") else { return nil }
    if let url = value as? URL { return url }
    if let text = value as? String { return URL(string: text) }
    return nil
}

// Long-lived evidence collection is explicit; the default remains one detector snapshot.
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


// Absence on an unrelated window is not an AX error. A successful reply with
// the wrong shape, and genuine transport/permission errors, remain incomplete.
func validatedZoomChildren(_ status: AXError, _ value: CFTypeRef?) -> [AXUIElement]? {
    if status == .noValue || status == .attributeUnsupported { return [] }
    guard status == .success, let children = value as? [AXUIElement], children.count <= 512 else { return nil }
    return children
}

struct ZoomActivityConfirmation {
    private var signature: String? = nil
    private var confirmed = false
    private(set) var episodeId = UUID().uuidString
    mutating func reset() { signature = nil; confirmed = false; episodeId = UUID().uuidString }
    mutating func observe(_ next: String, explicit: Bool) -> (emit: Bool, stable: Bool) {
        if next != signature {
            signature = next
            confirmed = false
            episodeId = UUID().uuidString
            return (true, false)
        }
        if explicit && !confirmed { confirmed = true; return (true, true) }
        return (false, confirmed)
    }
}

if CommandLine.arguments.contains("--self-test-zoom-collector") {
    let element = AXUIElementCreateApplication(getpid())
    precondition(validatedZoomChildren(.noValue, nil)?.isEmpty == true)
    precondition(validatedZoomChildren(.attributeUnsupported, nil)?.isEmpty == true)
    precondition(validatedZoomChildren(.success, [] as CFArray)?.isEmpty == true)
    precondition(validatedZoomChildren(.success, [element] as CFArray)?.count == 1)
    precondition(validatedZoomChildren(.success, "wrong-shape" as CFString) == nil)
    precondition(validatedZoomChildren(.cannotComplete, nil) == nil)
    var confirmation = ZoomActivityConfirmation()
    precondition(confirmation.observe("speaker-a", explicit: true).stable == false)
    let episode = confirmation.episodeId
    precondition(confirmation.observe("speaker-a", explicit: true).stable == true)
    precondition(confirmation.episodeId == episode)
    precondition(confirmation.observe("speaker-a", explicit: true).emit == false)
    precondition(confirmation.observe("speaker-b", explicit: true).stable == false)
    precondition(confirmation.episodeId != episode)
    confirmation.reset()
    precondition(confirmation.observe("speaker-b", explicit: true).stable == false)
    precondition(confirmation.observe("speaker-b", explicit: true).stable == true)
    precondition(confirmation.observe("candidate", explicit: false).stable == false)
    precondition(confirmation.observe("candidate", explicit: false).emit == false)
    print("Zoom collector children and stability checks passed")
    exit(0)
}

func collectZoom(recordingId: String) -> Never {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    func hostNS() -> UInt64 {
        let ticks = mach_absolute_time()
        return ticks / UInt64(timebase.denom) * UInt64(timebase.numer) +
            ticks % UInt64(timebase.denom) * UInt64(timebase.numer) / UInt64(timebase.denom)
    }
    func emitJSON(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    var session = UUID().uuidString
    var tracked: [(element: AXUIElement, key: String, name: String, revision: Int)] = []
    var confirmation = ZoomActivityConfirmation()
    var reads = 0
    var samples = 0
    var lastAvailability: String? = nil
    var pid: pid_t? = nil
    var previousWindows: [AXUIElement] = []
    func retire() {
        tracked.removeAll()
        previousWindows.removeAll()
        confirmation.reset()
        session = UUID().uuidString
    }
    func scan() {
        let before = hostNS()
        reads += 1
        var reason: String? = nil
        var seen: [AXUIElement] = []
        var videoWindows: [AXUIElement] = []
        var candidates: [(key: String, name: String, revision: Int, active: Bool, mode: String)] = []
        if !AXIsProcessTrusted() { reason = "accessibility" }
        else if let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "us.zoom.xos" }) {
            if pid != app.processIdentifier { retire(); pid = app.processIdentifier }
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(ax, 0.1)
            if let windows = elements(ax, kAXWindowsAttribute), windows.count <= 32 {
                for window in windows {
                    var rawChildren: CFTypeRef?
                    let childrenStatus = AXUIElementCopyAttributeValue(window, kAXChildrenAttribute as CFString, &rawChildren)
                    guard let children = validatedZoomChildren(childrenStatus, rawChildren) else {
                        reason = "ax-incomplete"; continue
                    }
                    let tiles = children.filter { string($0, kAXRoleAttribute) == "AXTabGroup" && string($0, kAXRoleDescriptionAttribute) == "Video render" }
                    if tiles.isEmpty { continue }
                    videoWindows.append(window)
                    let mode = string(window, kAXSubroleAttribute) == "AXSystemDialog" ? "compact" : "full"
                    for tile in tiles {
                        AXUIElementSetMessagingTimeout(tile, 0.1)
                        seen.append(tile)
                        guard let description = string(tile, kAXDescriptionAttribute), let parsed = parseTile(description) else {
                            reason = "tile-unparsed"; continue
                        }
                        var index = tracked.firstIndex(where: { CFEqual($0.element, tile) })
                        if index == nil {
                            tracked.append((element: tile, key: UUID().uuidString, name: parsed.name, revision: 1))
                            index = tracked.count - 1
                        }
                        let i = index!
                        if tracked[i].name != parsed.name { tracked[i].name = parsed.name; tracked[i].revision += 1 }
                        candidates.append((key: tracked[i].key, name: parsed.name, revision: tracked[i].revision,
                                           active: parsed.active && parsed.muted == false, mode: mode))
                    }
                }
                if !previousWindows.isEmpty && (videoWindows.count != previousWindows.count ||
                    videoWindows.contains(where: { window in !previousWindows.contains(where: { CFEqual($0, window) }) })) {
                    reason = reason ?? "video-window-changed"
                }
                previousWindows = videoWindows
                if seen.isEmpty && reason == nil { reason = "no-call-window" }
            } else { reason = "ax-unavailable" }
        } else { pid = nil; reason = "zoom-not-running" }
        let after = hostNS()
        if after - before > 1_000_000_000 { reason = "ax-read-timeout" }
        let active = candidates.filter { $0.active }
        if reason == nil && active.count > 1 { reason = "ambiguous-activity" }
        let available = reason ?? "available"
        if let reason, available != lastAvailability {
            emitJSON(["type": "observation", "observation": [
                "id": UUID().uuidString, "recordingId": recordingId, "sessionId": session,
                "instanceKey": "unavailable", "nameRevision": 1, "episodeId": UUID().uuidString,
                "displayName": "", "windowMode": "unknown", "activity": "unavailable",
                "readStartHostNs": String(before), "readEndHostNs": String(after),
                "self": "unknown", "singleSpeaker": NSNull(), "provenance": "unknown", "reason": reason
            ]])
            samples += 1
        }
        if reason != nil {
            // Unknown availability retires every identity. PID cannot bridge it.
            retire()
        } else {
            tracked.removeAll { item in !seen.contains(where: { CFEqual($0, item.element) }) }
            let selected = active.isEmpty ? candidates : active
            let next = selected.map { "\($0.key)/\($0.revision)/\($0.active)" }.sorted().joined(separator: "|")
            let sample = confirmation.observe(next, explicit: !active.isEmpty)
            if sample.emit {
                let episode = confirmation.episodeId
                for tile in selected {
                    emitJSON(["type": "observation", "observation": [
                        "id": UUID().uuidString, "recordingId": recordingId, "sessionId": session,
                        "instanceKey": tile.key, "nameRevision": tile.revision, "episodeId": episode,
                        "displayName": tile.name, "windowMode": tile.mode,
                        "activity": tile.active && sample.stable ? "explicit" : "candidate",
                        "readStartHostNs": String(before), "readEndHostNs": String(after),
                        "self": "unknown", "singleSpeaker": NSNull(), "provenance": "system-wide",
                        "reason": tile.active && sample.stable ? NSNull() as Any : (tile.active ? "activity-transition" : "activity-unconfirmed") as Any
                    ]])
                    samples += 1
                }
            }
        }
        if available != lastAvailability || reads % 10 == 0 {
            emitJSON(["type": "coverage", "reads": reads, "samples": samples,
                      "state": "collecting", "reason": reason as Any? ?? NSNull()])
            lastAvailability = available
        }
    }
    var signals: [DispatchSourceSignal] = []
    for value in [SIGINT, SIGTERM] {
        signal(value, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
        source.setEventHandler {
            emitJSON(["type": "coverage", "reads": reads, "samples": samples,
                      "state": lastAvailability == "available" ? "complete" : "incomplete",
                      "reason": lastAvailability == "available" ? NSNull() as Any : (lastAvailability ?? "no-evidence") as Any])
            exit(0)
        }
        source.resume()
        signals.append(source)
    }
    // 2 Hz is the measured starting point, not a calibrated sampling minimum.
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: .milliseconds(500))
    timer.setEventHandler { scan() }
    timer.resume()
    dispatchMain()
}
if let index = CommandLine.arguments.firstIndex(of: "--collect-zoom"), index + 1 < CommandLine.arguments.count {
    collectZoom(recordingId: CommandLine.arguments[index + 1])
}
guard AXIsProcessTrusted() else { print("unknown\taccessibility"); exit(0) }

let browsers: Set<String> = [
    "com.apple.Safari", "com.google.Chrome", "com.google.Chrome.canary",
    "org.chromium.Chromium", "com.microsoft.edgemac", "com.brave.Browser",
    "company.thebrowser.Browser", "org.mozilla.firefox"
]
for app in NSWorkspace.shared.runningApplications {
    guard let bundle = app.bundleIdentifier, app.processIdentifier > 0 else { continue }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    if bundle == "us.zoom.xos" {
        print("present\tzoom:\(app.processIdentifier)")
        guard let windows = elements(ax, kAXWindowsAttribute) else {
            print("unknown\tzoom")
            continue
        }
        var active = false
        var complete = true
        for window in windows where visible(window) {
            guard let result = hasZoomMeetingWindow(window) else {
                complete = false
                continue
            }
            if result { active = true }
        }
        let key = "zoom:\(app.processIdentifier)"
        if active { print("active\t\(key)") }
        else if complete { print("inactive\t\(key)") }
        else { print("unknown\tzoom") }
    } else if browsers.contains(bundle) {
        guard let window = attribute(ax, kAXFocusedWindowAttribute) as! AXUIElement?,
              let webArea = focusedWebArea(ax, window: window),
              let url = webURL(webArea),
              url.scheme?.lowercased() == "https", url.host?.lowercased() == "meet.google.com" else { continue }
        let key = "meet:\(meetingKey(url))"
        guard let active = hasMeetLeaveButton(webArea) else {
            print("unknown\tmeet")
            continue
        }
        print("\(active ? "active" : "inactive")\t\(key)")
    }
}
