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
    // Keep cursor reads in the same Quartz coordinate space used by CGEvent posts.
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

private func handle(_ json: [String: Any]) {
    let type = stringValue(json, key: "type") ?? ""

    do {
        switch type {
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

emitStatus()

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data, options: []),
          let json = object as? [String: Any] else {
        continue
    }

    handle(json)
}
