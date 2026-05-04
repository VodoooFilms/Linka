import ApplicationServices
import AppKit
import AudioToolbox
import CoreAudio
import Foundation

private enum NativeInputError: Error {
    case missingAccessibilityPermission
}

private let outputQueue = DispatchQueue(label: "linka.mac-input.output")

private struct VolumeState {
    let volume: Double
    let muted: Bool
}

private enum AudioControlError: Error {
    case propertyUnavailable(String)
    case osStatus(OSStatus, String)
}

// ============================================================================
// MARK: - Hermes Linka Event Capture
// ============================================================================

private struct CapturedEvent: Codable {
    let ts: Double          // Unix timestamp with milliseconds
    let type: String        // mouse_moved, left_down, left_up, right_down, right_up,
                            // key_combo, scroll, mouse_drag
    let x: Double?
    let y: Double?
    let key: String?        // virtual key code as hex string e.g. "0x24"
    let modifiers: [String]?
    let dy: Int32?          // scroll delta
}

private struct EventBuffer {
    private var events: [CapturedEvent] = []
    private let maxEvents: Int
    private let maxAgeSeconds: Double
    private let lock = NSLock()

    // Throttling state
    private var lastMovePoint: CGPoint = .zero
    private var lastMoveTime: Double = 0
    private let minMoveDelta: CGFloat = 20.0   // only capture moves >20px
    private let minMoveInterval: Double = 0.15  // max ~7 move events/sec

    init(maxEvents: Int = 600, maxAgeSeconds: Double = 60.0) {
        self.maxEvents = maxEvents
        self.maxAgeSeconds = maxAgeSeconds
    }

    mutating func append(_ event: CapturedEvent) {
        lock.lock()
        defer { lock.unlock() }

        // Throttle mouse moves: skip if too close to last captured move
        if event.type == "mouse_moved" {
            if let x = event.x, let y = event.y {
                let point = CGPoint(x: x, y: y)
                let dx = abs(point.x - lastMovePoint.x)
                let dy = abs(point.y - lastMovePoint.y)
                let dt = event.ts - lastMoveTime
                if dx < minMoveDelta && dy < minMoveDelta && dt < 0.3 {
                    return // skip — not enough movement
                }
                lastMovePoint = point
                lastMoveTime = event.ts
            }
            // Rate limit: if we just captured a move < minMoveInterval ago, skip
            if let last = events.last, last.type == "mouse_moved",
               event.ts - last.ts < minMoveInterval {
                return
            }
        }

        events.append(event)

        // Evict events older than maxAgeSeconds
        let cutoff = event.ts - maxAgeSeconds
        while let first = events.first, first.ts < cutoff {
            events.removeFirst()
        }

        // Evict oldest if over capacity
        while events.count > maxEvents {
            events.removeFirst()
        }
    }

    func dump() -> [CapturedEvent] {
        lock.lock()
        defer { lock.unlock() }

        let now = Date().timeIntervalSince1970
        let cutoff = now - maxAgeSeconds
        let filtered = events.filter { $0.ts >= cutoff }
        return Array(filtered.suffix(maxEvents))
    }

    mutating func clear() {
        lock.lock()
        defer { lock.unlock() }
        events.removeAll()
        lastMovePoint = .zero
        lastMoveTime = 0
    }
}

// Virtual key code → readable name (common keys)
private let keyNameMap: [CGKeyCode: String] = [
    0x00: "a", 0x01: "s", 0x02: "d", 0x03: "f", 0x04: "h", 0x05: "g",
    0x06: "z", 0x07: "x", 0x08: "c", 0x09: "v", 0x0B: "b",
    0x0C: "q", 0x0D: "w", 0x0E: "e", 0x0F: "r", 0x10: "y", 0x11: "t",
    0x12: "1", 0x13: "2", 0x14: "3", 0x15: "4", 0x16: "6", 0x17: "5",
    0x18: "=", 0x19: "9", 0x1A: "7", 0x1B: "-", 0x1C: "8", 0x1D: "0",
    0x1F: "o", 0x20: "u", 0x22: "i", 0x23: "p",
    0x24: "return", 0x25: "l", 0x26: "j", 0x28: "k",
    0x29: ";", 0x2B: ",", 0x2C: "/", 0x2D: "n", 0x2E: "m", 0x2F: ".",
    0x30: "tab", 0x31: "space",
    0x33: "delete", 0x35: "escape",
    0x37: "cmd", 0x38: "shift", 0x3A: "option", 0x3B: "control",
    0x7B: "left", 0x7C: "right", 0x7D: "down", 0x7E: "up",
    0x60: "f5", 0x61: "f6", 0x62: "f7",
]

private var eventBuffer = EventBuffer()
private var captureActive = false
private var eventTap: CFMachPort?
private var teachMarker: Double? = nil

private func modifierNames(from flags: CGEventFlags) -> [String] {
    var names: [String] = []
    if flags.contains(.maskCommand)  { names.append("cmd") }
    if flags.contains(.maskShift)    { names.append("shift") }
    if flags.contains(.maskAlternate){ names.append("option") }
    if flags.contains(.maskControl)  { names.append("control") }
    return names
}

private func captureEventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    let now = Date().timeIntervalSince1970
    let location = event.location

    var captured: CapturedEvent?

    switch type {
    case .mouseMoved:
        captured = CapturedEvent(
            ts: now, type: "mouse_moved",
            x: Double(location.x), y: Double(location.y),
            key: nil, modifiers: nil, dy: nil
        )

    case .leftMouseDown:
        captured = CapturedEvent(
            ts: now, type: "left_down",
            x: Double(location.x), y: Double(location.y),
            key: nil, modifiers: nil, dy: nil
        )

    case .leftMouseUp:
        captured = CapturedEvent(
            ts: now, type: "left_up",
            x: Double(location.x), y: Double(location.y),
            key: nil, modifiers: nil, dy: nil
        )

    case .rightMouseDown:
        captured = CapturedEvent(
            ts: now, type: "right_down",
            x: Double(location.x), y: Double(location.y),
            key: nil, modifiers: nil, dy: nil
        )

    case .rightMouseUp:
        captured = CapturedEvent(
            ts: now, type: "right_up",
            x: Double(location.x), y: Double(location.y),
            key: nil, modifiers: nil, dy: nil
        )

    case .scrollWheel:
        let deltaY = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
        guard deltaY != 0 else { break }
        captured = CapturedEvent(
            ts: now, type: "scroll",
            x: Double(location.x), y: Double(location.y),
            key: nil, modifiers: nil, dy: Int32(deltaY)
        )

    case .keyDown:
        let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        let flags = event.flags
        let mods = modifierNames(from: flags)
        // Capture key combos or special keys. During teach mode, capture ALL keystrokes.
        if teachMarker != nil || !mods.isEmpty || isSpecialKey(keyCode) {
            let keyName = keyNameMap[keyCode] ?? String(format: "0x%02X", keyCode)
            captured = CapturedEvent(
                ts: now, type: "key_combo",
                x: nil, y: nil,
                key: keyName, modifiers: mods.isEmpty ? nil : mods, dy: nil
            )
        }

    case .leftMouseDragged:
        captured = CapturedEvent(
            ts: now, type: "mouse_drag",
            x: Double(location.x), y: Double(location.y),
            key: nil, modifiers: nil, dy: nil
        )

    default:
        break
    }

    if let evt = captured {
        eventBuffer.append(evt)
    }

    // Always pass the event through — we're listen-only
    return Unmanaged.passUnretained(event)
}

private func isSpecialKey(_ keyCode: CGKeyCode) -> Bool {
    // Keys that indicate user intent even without modifiers
    let specials: Set<CGKeyCode> = [
        0x24,  // return
        0x30,  // tab
        0x35,  // escape
        0x33,  // delete/backspace
        0x31,  // space
        0x7B, 0x7C, 0x7D, 0x7E,  // arrows
        0x60, 0x61, 0x62,  // f5-f7
    ]
    return specials.contains(keyCode)
}

private func startEventCapture() -> Bool {
    guard !captureActive else { return true }

    let eventMask: CGEventMask = (
        (1 << CGEventType.mouseMoved.rawValue) |
        (1 << CGEventType.leftMouseDown.rawValue) |
        (1 << CGEventType.leftMouseUp.rawValue) |
        (1 << CGEventType.rightMouseDown.rawValue) |
        (1 << CGEventType.rightMouseUp.rawValue) |
        (1 << CGEventType.scrollWheel.rawValue) |
        (1 << CGEventType.keyDown.rawValue) |
        (1 << CGEventType.leftMouseDragged.rawValue)
    )

    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: eventMask,
        callback: captureEventCallback,
        userInfo: nil
    ) else {
        writeError("Failed to create event tap. Check Accessibility permissions.",
                    code: "event_tap_failed")
        return false
    }

    eventTap = tap

    let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)

    captureActive = true
    writeJson([
        "type": "capture_status",
        "active": true,
        "message": "Event capture started (Hermes Linka mode).",
    ])
    return true
}

private func stopEventCapture() {
    guard captureActive, let tap = eventTap else { return }

    CGEvent.tapEnable(tap: tap, enable: false)
    // CFRunLoopRemoveSource not needed — tap is disabled and will be released
    eventTap = nil
    captureActive = false
    eventBuffer.clear()

    writeJson([
        "type": "capture_status",
        "active": false,
        "message": "Event capture stopped. Buffer cleared.",
    ])
}

private func dumpEvents() {
    let events = eventBuffer.dump()

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

    guard let jsonData = try? encoder.encode(events),
          let jsonString = String(data: jsonData, encoding: .utf8) else {
        writeError("Failed to encode event buffer.")
        return
    }

    // Write the raw event array via stdout so the Node adapter can pipe it
    writeJson([
        "type": "events_dump",
        "count": events.count,
        "active": captureActive,
    ])

    // Also write the events as a newline-delimited JSON payload on stdout
    // The Node adapter will capture this as a special response
    outputQueue.sync {
        let payload = "EVENTS_JSON:\(jsonString.replacingOccurrences(of: "\n", with: ""))\n"
        FileHandle.standardOutput.write(Data(payload.utf8))
    }
}

// ============================================================================
// MARK: - JSON Output Helpers (existing)
// ============================================================================

private func writeJson(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          var text = String(data: data, encoding: .utf8) else {
        return
    }

    text.append("\n")
    outputQueue.sync {
        FileHandle.standardOutput.write(Data(text.utf8))
    }
}

private func writeError(_ message: String, code: String? = nil) {
    var payload: [String: Any] = [
        "type": "error",
        "message": message,
    ]
    if let code {
        payload["code"] = code
    }
    writeJson(payload)
}

private func runAppleScript(_ source: String) throws -> String {
    let process = Process()
    let pipe = Pipe()
    let errorPipe = Pipe()

    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", source]
    process.standardOutput = pipe
    process.standardError = errorPipe

    try process.run()
    process.waitUntilExit()

    let stdout = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let stderr = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

    if process.terminationStatus != 0 {
        throw NSError(
            domain: "Linka.NativeInput",
            code: Int(process.terminationStatus),
            userInfo: [NSLocalizedDescriptionKey: stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "AppleScript command failed." : stderr.trimmingCharacters(in: .whitespacesAndNewlines)]
        )
    }

    return stdout.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func defaultOutputDeviceID() throws -> AudioDeviceID {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &size,
        &deviceID
    )

    guard status == noErr else {
        throw AudioControlError.osStatus(status, "Unable to resolve default output device.")
    }

    return deviceID
}

private func audioPropertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
}

private func hasAudioProperty(_ deviceID: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> Bool {
    var address = audioPropertyAddress(selector)
    return AudioObjectHasProperty(deviceID, &address)
}

private func readVirtualMainVolume(_ deviceID: AudioDeviceID) throws -> Float32 {
    guard hasAudioProperty(deviceID, kAudioHardwareServiceDeviceProperty_VirtualMainVolume) else {
        throw AudioControlError.propertyUnavailable("Virtual main volume is unavailable on this output device.")
    }

    var value = Float32(0)
    var size = UInt32(MemoryLayout<Float32>.size)
    var address = audioPropertyAddress(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &value)

    guard status == noErr else {
        throw AudioControlError.osStatus(status, "Unable to read output volume.")
    }

    return value
}

private func writeVirtualMainVolume(_ deviceID: AudioDeviceID, value: Float32) throws {
    guard hasAudioProperty(deviceID, kAudioHardwareServiceDeviceProperty_VirtualMainVolume) else {
        throw AudioControlError.propertyUnavailable("Virtual main volume is unavailable on this output device.")
    }

    var newValue = max(0, min(1, value))
    let size = UInt32(MemoryLayout<Float32>.size)
    var address = audioPropertyAddress(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
    let status = AudioObjectSetPropertyData(deviceID, &address, 0, nil, size, &newValue)

    guard status == noErr else {
        throw AudioControlError.osStatus(status, "Unable to change output volume.")
    }
}

private func readMuted(_ deviceID: AudioDeviceID) throws -> Bool {
    guard hasAudioProperty(deviceID, kAudioDevicePropertyMute) else {
        return false
    }

    var muted: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var address = audioPropertyAddress(kAudioDevicePropertyMute)
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &muted)

    guard status == noErr else {
        throw AudioControlError.osStatus(status, "Unable to read mute state.")
    }

    return muted != 0
}

private func writeMuted(_ deviceID: AudioDeviceID, muted: Bool) throws {
    guard hasAudioProperty(deviceID, kAudioDevicePropertyMute) else {
        throw AudioControlError.propertyUnavailable("Mute is unavailable on this output device.")
    }

    var value: UInt32 = muted ? 1 : 0
    let size = UInt32(MemoryLayout<UInt32>.size)
    var address = audioPropertyAddress(kAudioDevicePropertyMute)
    let status = AudioObjectSetPropertyData(deviceID, &address, 0, nil, size, &value)

    guard status == noErr else {
        throw AudioControlError.osStatus(status, "Unable to change mute state.")
    }
}

private func isAccessibilityTrusted(prompt: Bool = false) -> Bool {
    if prompt {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
    return AXIsProcessTrusted()
}

private func requireAccessibility() throws {
    if !isAccessibilityTrusted() {
        throw NativeInputError.missingAccessibilityPermission
    }
}

private func emitStatus() {
    let trusted = isAccessibilityTrusted(prompt: true)
    writeJson([
        "type": "status",
        "ready": trusted,
        "permission": trusted ? NSNull() : "accessibility",
        "message": trusted
            ? "macOS native input is ready."
            : "Accessibility permission is required. Enable Linka in System Settings > Privacy & Security > Accessibility.",
    ])
}

private func mouseButton(_ button: String, down: Bool) -> CGMouseButton {
    switch button.lowercased() {
    case "right":
        return .right
    default:
        return .left
    }
}

private func mouseEventType(_ button: CGMouseButton, down: Bool) -> CGEventType {
    switch (button, down) {
    case (.right, true):
        return .rightMouseDown
    case (.right, false):
        return .rightMouseUp
    case (_, true):
        return .leftMouseDown
    default:
        return .leftMouseUp
    }
}

private func currentCursorPosition() -> CGPoint {
    guard let event = CGEvent(source: nil) else {
        return .zero
    }
    return event.location
}

private func desktopBounds() -> CGRect {
    var displayCount: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
        return .zero
    }

    let maxDisplays = Int(displayCount)
    var displays = Array(repeating: CGDirectDisplayID(), count: maxDisplays)
    guard CGGetActiveDisplayList(displayCount, &displays, &displayCount) == .success else {
        return .zero
    }

    var unionRect = CGRect.null
    for display in displays.prefix(Int(displayCount)) {
        unionRect = unionRect.union(CGDisplayBounds(display))
    }

    return unionRect.isNull ? .zero : unionRect
}

private func clampCursorPoint(_ point: CGPoint) -> CGPoint {
    let bounds = desktopBounds()
    guard !bounds.isEmpty else {
        return point
    }

    let maxX = bounds.maxX - 1
    let maxY = bounds.maxY - 1
    return CGPoint(
        x: min(max(point.x, bounds.minX), maxX),
        y: min(max(point.y, bounds.minY), maxY)
    )
}

private func postMouseMove(dx: Int, dy: Int) throws {
    var point = currentCursorPosition()
    point.x += CGFloat(dx)
    point.y += CGFloat(dy)
    CGWarpMouseCursorPosition(clampCursorPoint(point))
}

private func postMouseButton(button rawButton: String, down: Bool) throws {
    try requireAccessibility()
    let button = mouseButton(rawButton, down: down)
    let type = mouseEventType(button, down: down)
    let point = currentCursorPosition()
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        return
    }
    event.post(tap: .cghidEventTap)
}

private func postClick(button: String, double: Bool) throws {
    let clicks = double ? 2 : 1
    for clickIndex in 0..<clicks {
        try postMouseButton(button: button, down: true)
        usleep(18_000)
        try postMouseButton(button: button, down: false)
        if double && clickIndex == 0 {
          usleep(70_000)
        }
    }
}

private func postScroll(dy: Int) throws {
    try requireAccessibility()
    guard dy != 0 else {
        return
    }

    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0) else {
        return
    }
    event.post(tap: .cghidEventTap)
}

private func postText(_ text: String) throws {
    try requireAccessibility()
    guard !text.isEmpty else {
        return
    }

    for scalar in text.utf16 {
        var character = UniChar(scalar)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            continue
        }

        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

private func stringArrayValue(_ json: [String: Any], key: String) -> [String] {
    guard let array = json[key] as? [Any] else {
        return []
    }

    return array.compactMap { $0 as? String }
}

private func keyCode(for key: String) -> CGKeyCode? {
    switch key.lowercased() {
    case "a": return 0x00
    case "s": return 0x01
    case "d": return 0x02
    case "f": return 0x03
    case "h": return 0x04
    case "g": return 0x05
    case "z": return 0x06
    case "x": return 0x07
    case "c": return 0x08
    case "v": return 0x09
    case "b": return 0x0B
    case "q": return 0x0C
    case "w": return 0x0D
    case "e": return 0x0E
    case "r": return 0x0F
    case "y": return 0x10
    case "t": return 0x11
    case "1": return 0x12
    case "2": return 0x13
    case "3": return 0x14
    case "4": return 0x15
    case "6": return 0x16
    case "5": return 0x17
    case "9": return 0x19
    case "7": return 0x1A
    case "8": return 0x1C
    case "0": return 0x1D
    case "o": return 0x1F
    case "u": return 0x20
    case "i": return 0x22
    case "p": return 0x23
    case "enter", "return": return 0x24
    case "l": return 0x25
    case "j": return 0x26
    case "k": return 0x28
    case ";": return 0x29
    case ",": return 0x2B
    case "/": return 0x2C
    case "n": return 0x2D
    case "m": return 0x2E
    case ".": return 0x2F
    case "tab": return 0x30
    case "space": return 0x31
    case "backspace", "delete": return 0x33
    case "escape", "esc": return 0x35
    case "command", "cmd", "meta": return 0x37
    case "shift": return 0x38
    case "option", "alt": return 0x3A
    case "control", "ctrl": return 0x3B
    case "=": return 0x18
    case "-": return 0x1B
    default: return nil
    }
}

private func postKeyEvent(_ keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags = []) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: keyDown) else {
        return
    }

    event.flags = flags
    event.post(tap: .cghidEventTap)
}

private func postKeyTap(key: String, modifiers: [String]) throws {
    try requireAccessibility()

    guard let targetKeyCode = keyCode(for: key) else {
        writeError("Unknown macOS key: \(key)")
        return
    }

    let modifierKeyCodes = modifiers.compactMap { keyCode(for: $0) }
    let flags = modifiers.reduce(into: CGEventFlags()) { result, modifier in
        switch modifier.lowercased() {
        case "command", "cmd", "meta":
            result.insert(.maskCommand)
        case "control", "ctrl":
            result.insert(.maskControl)
        case "shift":
            result.insert(.maskShift)
        case "option", "alt":
            result.insert(.maskAlternate)
        default:
            break
        }
    }

    for modifierKeyCode in modifierKeyCodes {
        postKeyEvent(modifierKeyCode, keyDown: true)
    }

    postKeyEvent(targetKeyCode, keyDown: true, flags: flags)
    postKeyEvent(targetKeyCode, keyDown: false, flags: flags)

    for modifierKeyCode in modifierKeyCodes.reversed() {
        postKeyEvent(modifierKeyCode, keyDown: false)
    }
}

private func getVolumeState() throws -> VolumeState {
    do {
        let deviceID = try defaultOutputDeviceID()
        let volume = try readVirtualMainVolume(deviceID)
        let muted = try readMuted(deviceID)
        return VolumeState(
            volume: Double(max(0, min(1, volume))),
            muted: muted
        )
    } catch {
        let output = try runAppleScript("set s to get volume settings\nreturn (output volume of s as string) & \"|\" & (output muted of s as string)")
        let parts = output.split(separator: "|", omittingEmptySubsequences: false)
        let volumePercent = parts.first.flatMap { Double($0) } ?? 0
        let muted = parts.dropFirst().first.map { $0.lowercased() == "true" } ?? false
        return VolumeState(
            volume: max(0, min(1, volumePercent / 100)),
            muted: muted
        )
    }
}

private func emitVolumeState() throws {
    let state = try getVolumeState()
    writeJson([
        "type": "volume_state",
        "volume": state.volume,
        "muted": state.muted,
    ])
}

private func setVolume(_ value: Double) throws {
    do {
        let deviceID = try defaultOutputDeviceID()
        try writeVirtualMainVolume(deviceID, value: Float32(value))
    } catch {
        let volumePercent = Int(max(0, min(100, round(value * 100))))
        _ = try runAppleScript("set volume output volume \(volumePercent)")
    }
}

private func setMute(_ muted: Bool) throws {
    do {
        let deviceID = try defaultOutputDeviceID()
        try writeMuted(deviceID, muted: muted)
    } catch {
        _ = try runAppleScript("set volume output muted \(muted ? "true" : "false")")
    }
}

private func toggleMute() throws {
    do {
        let deviceID = try defaultOutputDeviceID()
        let muted = try readMuted(deviceID)
        try writeMuted(deviceID, muted: !muted)
    } catch {
        _ = try runAppleScript("set volume output muted not (output muted of (get volume settings))")
    }
}

private func stringValue(_ json: [String: Any], key: String) -> String? {
    json[key] as? String
}

private func intValue(_ json: [String: Any], key: String) -> Int {
    if let number = json[key] as? NSNumber {
        return number.intValue
    }
    if let string = json[key] as? String, let int = Int(string) {
        return int
    }
    return 0
}

private func boolValue(_ json: [String: Any], key: String) -> Bool {
    if let value = json[key] as? Bool {
        return value
    }
    if let number = json[key] as? NSNumber {
        return number.boolValue
    }
    return false
}

private func doubleValue(_ json: [String: Any], key: String) -> Double {
    if let number = json[key] as? NSNumber {
        return number.doubleValue
    }
    if let string = json[key] as? String, let value = Double(string) {
        return value
    }
    return 0
}

// ============================================================================
// MARK: - Command Handler (extended with Hermes Linka commands)
// ============================================================================

private func handle(_ json: [String: Any]) {
    let type = stringValue(json, key: "type") ?? ""

    do {
        switch type {
        // --- Existing commands ---
        case "status", "getstatus":
            emitStatus()
        case "move":
            try postMouseMove(dx: intValue(json, key: "dx"), dy: intValue(json, key: "dy"))
        case "mousedown":
            try postMouseButton(button: stringValue(json, key: "button") ?? "left", down: true)
        case "mouseup":
            try postMouseButton(button: stringValue(json, key: "button") ?? "left", down: false)
        case "click":
            try postClick(button: stringValue(json, key: "button") ?? "left", double: boolValue(json, key: "double"))
        case "scroll":
            try postScroll(dy: intValue(json, key: "dy"))
        case "type":
            try postText(stringValue(json, key: "text") ?? "")
        case "keytap":
            try postKeyTap(
                key: stringValue(json, key: "key") ?? "",
                modifiers: stringArrayValue(json, key: "modifiers")
            )
        case "volume":
            try setVolume(doubleValue(json, key: "value"))
        case "mute":
            try setMute(boolValue(json, key: "muted"))
            try emitVolumeState()
        case "togglemute":
            try toggleMute()
            try emitVolumeState()
        case "getvolume":
            try emitVolumeState()

        // --- Hermes Linka commands ---
        case "capture_start":
            _ = startEventCapture()

        case "capture_stop":
            stopEventCapture()

        case "capture_status":
            writeJson([
                "type": "capture_status",
                "active": captureActive,
                "buffer_count": eventBuffer.dump().count,
            ])

        case "dump_events":
            // Auto-start capture if not active
            if !captureActive {
                _ = startEventCapture()
                // Small delay to ensure we have at least some events if buffer was empty
                usleep(100_000) // 100ms
            }
            dumpEvents()

        // --- Hermes Linka Teach mode ---
        case "teach_start":
            teachMarker = Date().timeIntervalSince1970
            let currentCount = eventBuffer.dump().count
            writeJson([
                "type": "teach_status",
                "active": true,
                "marker_ts": teachMarker!,
                "buffer_count": currentCount,
                "message": currentCount > 0
                    ? "Teach recording started."
                    : "WARNING: Event buffer is empty. Check Accessibility permission.",
            ])

        case "teach_stop":
            guard let marker = teachMarker else {
                writeError("No teach recording in progress.", code: "teach_not_active")
                break
            }
            let allEvents = eventBuffer.dump()
            let recorded = allEvents.filter { $0.ts >= marker }
            teachMarker = nil

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            guard let jsonData = try? encoder.encode(recorded),
                  let jsonString = String(data: jsonData, encoding: .utf8) else {
                writeError("Failed to encode teach events.", code: "teach_encode_failed")
                break
            }

            writeJson([
                "type": "teach_events",
                "count": recorded.count,
                "marker_ts": marker,
            ])

            outputQueue.sync {
                let payload = "EVENTS_JSON:\(jsonString.replacingOccurrences(of: "\n", with: ""))\n"
                FileHandle.standardOutput.write(Data(payload.utf8))
            }

        default:
            break
        }
    } catch NativeInputError.missingAccessibilityPermission {
        emitStatus()
        writeError(
            "Accessibility permission is required. Enable Linka in System Settings > Privacy & Security > Accessibility.",
            code: "accessibility_permission_missing"
        )
    } catch {
        writeError(error.localizedDescription)
    }
}

// ============================================================================
// MARK: - Main Loop
// ============================================================================

emitStatus()

// Hermes Linka: auto-start capture on launch (it's listen-only, no overhead)
_ = startEventCapture()

// Use DispatchSource on stdin so the main run loop can process event tap callbacks
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
var stdinBuf = ""
stdinSource.setEventHandler {
    let data = FileHandle.standardInput.availableData
    guard !data.isEmpty else {
        // stdin closed — clean exit
        stopEventCapture()
        exit(0)
    }
    stdinBuf += String(data: data, encoding: .utf8) ?? ""
    while let nl = stdinBuf.firstIndex(of: "\n") {
        let line = String(stdinBuf[..<nl])
        stdinBuf = String(stdinBuf[stdinBuf.index(after: nl)...])
        guard let d = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d, options: []),
              let json = obj as? [String: Any] else {
            continue
        }
        handle(json)
    }
}
stdinSource.setCancelHandler { exit(0) }
stdinSource.resume()

RunLoop.current.run()
