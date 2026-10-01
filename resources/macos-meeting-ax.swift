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

// Only explicit self labels count; an ordinary display name is not self proof.
func zoomSelfName(_ name: String) -> (name: String, local: Bool) {
    for suffix in [" (Me)", " (me)", " (You)", " (you)", " (Я)", " (я)"] where name.hasSuffix(suffix) {
        return (String(name.dropLast(suffix.count)), true)
    }
    return (name, false)
}
struct ZoomActivityRange {
    let episode: String
    let activity: String
    let start: UInt64
    let end: UInt64
}
struct ZoomActivityConfirmation {
    private var signature: String? = nil
    private var confirmed = false
    private var explicit = false
    private var rangeStart: UInt64 = 0
    private var lastEnd: UInt64 = 0
    private var continuingReads = 0
    private(set) var episodeId = UUID().uuidString
    mutating func close() -> ZoomActivityRange? {
        let value = confirmed && lastEnd > rangeStart ? ZoomActivityRange(episode: episodeId, activity: "end", start: rangeStart, end: lastEnd) : nil
        signature = nil; confirmed = false; explicit = false; continuingReads = 0
        return value
    }
    mutating func observe(_ next: String, explicit active: Bool, before: UInt64, after: UInt64) -> (closed: ZoomActivityRange?, sample: ZoomActivityRange?) {
        if next != signature || explicit != active {
            let closed = close()
            signature = next; explicit = active; episodeId = UUID().uuidString
            rangeStart = after; lastEnd = after
            return (closed, ZoomActivityRange(episode: episodeId, activity: active ? "candidate" : "clear", start: before, end: after))
        }
        lastEnd = after
        guard active else { return (nil, nil) }
        continuingReads += 1
        if !confirmed || continuingReads >= 2 {
            confirmed = true; continuingReads = 0
            let sample = before > rangeStart ? ZoomActivityRange(episode: episodeId, activity: "explicit", start: rangeStart, end: before) : nil
            rangeStart = before
            return (nil, sample)
        }
        return (nil, nil)
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
    precondition(zoomSelfName("Fixture (Me)").local)
    precondition(zoomSelfName("Fixture (я)").name == "Fixture")
    precondition(!zoomSelfName("Fixture").local)
    var confirmation = ZoomActivityConfirmation()
    precondition(confirmation.observe("a", explicit: true, before: 0, after: 10).sample?.activity == "candidate")
    let episode = confirmation.episodeId
    let first = confirmation.observe("a", explicit: true, before: 500, after: 510).sample!
    precondition(first.activity == "explicit" && first.start == 10 && first.end == 500)
    precondition(confirmation.episodeId == episode)
    precondition(confirmation.observe("a", explicit: true, before: 1000, after: 1010).sample == nil)
    precondition(confirmation.observe("a", explicit: true, before: 1500, after: 1510).sample?.episode == episode)
    let switchRead = confirmation.observe("b", explicit: true, before: 2000, after: 2010)
    precondition(switchRead.closed?.end == 1510 && switchRead.sample?.activity == "candidate")
    precondition(confirmation.episodeId != episode)
    precondition(confirmation.close() == nil)
    precondition(confirmation.observe("b", explicit: true, before: 3000, after: 3010).sample?.activity == "candidate")
    precondition(confirmation.observe("b", explicit: true, before: 3500, after: 3510).sample?.activity == "explicit")
    precondition(confirmation.close()?.end == 3510)
    print("Zoom collector children, self labels and activity intervals passed")
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
    typealias Tile = (key: String, name: String, revision: Int, active: Bool, mode: String, local: Bool)
    var previousSelection: [Tile] = []
    var previousReadEnd: UInt64? = nil
    var reads = 0
    var samples = 0
    var lastAvailability: String? = nil
    var pid: pid_t? = nil
    var previousWindows: [AXUIElement] = []
    func retire() {
        tracked.removeAll()
        previousWindows.removeAll()
        _ = confirmation.close()
        previousSelection.removeAll()
        previousReadEnd = nil
        session = UUID().uuidString
    }
    func emitRange(_ range: ZoomActivityRange, _ tiles: [Tile]) {
        for tile in tiles {
            emitJSON(["type": "observation", "observation": [
                "id": UUID().uuidString, "recordingId": recordingId, "sessionId": session,
                "instanceKey": tile.key, "nameRevision": tile.revision, "episodeId": range.episode,
                "displayName": tile.name, "windowMode": tile.mode, "activity": range.activity,
                "readStartHostNs": String(range.start), "readEndHostNs": String(range.end),
                "self": tile.local ? "local" : "unknown", "singleSpeaker": NSNull(), "provenance": "system-wide",
                "reason": range.activity == "candidate" ? "activity-transition" as Any : NSNull()
            ]])
            samples += 1
        }
    }
    func closeActivity() {
        if let range = confirmation.close() { emitRange(range, previousSelection) }
    }
    func scan() {
        let before = hostNS()
        reads += 1
        var reason: String? = nil
        var seen: [AXUIElement] = []
        var videoWindows: [AXUIElement] = []
        var candidates: [Tile] = []
        if !AXIsProcessTrusted() { reason = "accessibility" }
        else if let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "us.zoom.xos" }) {
            if pid != app.processIdentifier { closeActivity(); retire(); pid = app.processIdentifier }
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
                        if seen.contains(where: { CFEqual($0, tile) }) { continue }
                        seen.append(tile)
                        guard let description = string(tile, kAXDescriptionAttribute), let parsed = parseTile(description) else {
                            reason = "tile-unparsed"; continue
                        }
                        let identity = zoomSelfName(parsed.name)
                        var index = tracked.firstIndex(where: { CFEqual($0.element, tile) })
                        if index == nil {
                            tracked.append((element: tile, key: UUID().uuidString, name: identity.name, revision: 1))
                            index = tracked.count - 1
                        }
                        let i = index!
                        if tracked[i].name != identity.name { tracked[i].name = identity.name; tracked[i].revision += 1 }
                        candidates.append((key: tracked[i].key, name: identity.name, revision: tracked[i].revision,
                                           active: parsed.active && parsed.muted == false, mode: mode, local: identity.local))
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
        if let previous = previousReadEnd, before > previous && before - previous > 1_000_000_000 { reason = "activity-poll-gap" }
        previousReadEnd = after
        let active = candidates.filter { $0.active }
        if reason == nil && active.count > 1 { reason = "ambiguous-activity" }
        if reason == nil, let speaker = active.first, candidates.filter({ $0.name == speaker.name }).count > 1 { reason = "duplicate-display-name" }
        let available = reason ?? "available"
        if reason != nil { closeActivity() }
        if let reason, available != lastAvailability {
            emitJSON(["type": "observation", "observation": [
                "id": UUID().uuidString, "recordingId": recordingId, "sessionId": session,
                "instanceKey": "unavailable", "nameRevision": 1, "episodeId": UUID().uuidString,
                "displayName": reason == "duplicate-display-name" ? (active.first?.name ?? "") : "", "windowMode": "unknown", "activity": "unavailable",
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
            let next = selected.map { "\($0.key)/\($0.revision)/\($0.active)/\($0.local)" }.sorted().joined(separator: "|")
            let sample = confirmation.observe(next, explicit: !active.isEmpty, before: before, after: after)
            if let closed = sample.closed { emitRange(closed, previousSelection) }
            if let range = sample.sample { emitRange(range, selected) }
            previousSelection = selected
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
            closeActivity()
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
