import AppKit
import ApplicationServices
import CryptoKit
import Foundation

// One bounded snapshot. A missing or incomplete AX tree never proves a call.
guard AXIsProcessTrusted() else {
    print("unknown\taccessibility")
    exit(0)
}

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
