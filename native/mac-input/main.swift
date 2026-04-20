import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum LinkaNativeInputMac {
    private static var lastAccessibilityStatus: Bool?
    private static var activeButton: String?

    static func run() {
        emitStatusIfNeeded(force: true)

        while let line = readLine(strippingNewline: true) {
            handle(line)
        }
    }

    private static func handle(_ line: String) {
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let command = object as? [String: Any]
        else {
            fputs("Invalid JSON command.\n", stderr)
            return
        }

        emitStatusIfNeeded()

        switch string(command, "type") {
        case "move":
            move(dx: int(command, "dx"), dy: int(command, "dy"))
        case "mousedown":
            mouseButton(button: string(command, "button") ?? "left", down: true)
        case "mouseup":
            mouseButton(button: string(command, "button") ?? "left", down: false)
        case "click":
            click(button: string(command, "button") ?? "left", doubleClick: bool(command, "double"))
        case "scroll":
            scroll(dy: int(command, "dy"))
        case "zoom":
            zoom(direction: string(command, "direction") ?? "in")
        case "type":
            typeText(string(command, "text") ?? "")
        case "keytap":
            keyTap(key: string(command, "key") ?? "", modifiers: stringArray(command, "modifiers"))
        case "volume":
            setVolume(float(command, "value"))
        case "mute":
            setMute(bool(command, "muted"))
        case "togglemute":
            toggleMute()
        default:
            break
        }
    }

    private static func currentMouseLocation() -> CGPoint {
        if let event = CGEvent(source: nil) {
            return event.location
        }

        let location = NSEvent.mouseLocation
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        return CGPoint(x: location.x, y: max(0, screenHeight - location.y))
    }

    private static func mouseEventType(button: String, down: Bool) -> CGEventType {
        let isRightButton = button.lowercased() == "right"
        if isRightButton {
            return down ? .rightMouseDown : .rightMouseUp
        }
        return down ? .leftMouseDown : .leftMouseUp
    }

    private static func mouseButtonValue(_ button: String) -> CGMouseButton {
        button.lowercased() == "right" ? .right : .left
    }

    private static func postMouse(type: CGEventType, button: String, clickState: Int64 = 1, at location: CGPoint? = nil) {
        let point = location ?? currentMouseLocation()
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: mouseButtonValue(button)
        ) else {
            fputs("Failed to create mouse event.\n", stderr)
            return
        }

        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        event.post(tap: .cghidEventTap)
    }

    private static func move(dx: Int, dy: Int) {
        let current = currentMouseLocation()
        let next = CGPoint(x: current.x + CGFloat(dx), y: current.y + CGFloat(dy))
        let moveType: CGEventType
        switch activeButton {
        case "left":
            moveType = .leftMouseDragged
        case "right":
            moveType = .rightMouseDragged
        default:
            moveType = .mouseMoved
        }

        postMouse(type: moveType, button: activeButton ?? "left", at: next)
    }

    private static func mouseButton(button: String, down: Bool) {
        activeButton = down ? normalizedButton(button) : nil
        postMouse(type: mouseEventType(button: button, down: down), button: button)
    }

    private static func click(button: String, doubleClick: Bool) {
        let clicks = doubleClick ? 2 : 1
        let location = currentMouseLocation()

        for clickIndex in 0..<clicks {
            let state = Int64(clickIndex + 1)
            postMouse(type: mouseEventType(button: button, down: true), button: button, clickState: state, at: location)
            usleep(18_000)
            postMouse(type: mouseEventType(button: button, down: false), button: button, clickState: state, at: location)
            if clickIndex + 1 < clicks {
                usleep(70_000)
            }
        }

        activeButton = nil
    }

    private static func scroll(dy: Int) {
        let amount = Int32(max(-12, min(12, dy)))
        guard amount != 0 else { return }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 1,
            wheel1: amount,
            wheel2: 0,
            wheel3: 0
        ) else {
            fputs("Failed to create scroll event.\n", stderr)
            return
        }

        event.post(tap: .cghidEventTap)
    }

    private static func zoom(direction: String) {
        if direction.lowercased() == "out" {
            keyTap(key: "-", modifiers: ["command"])
        } else {
            keyTap(key: "=", modifiers: ["command"])
        }
    }

    private static func typeText(_ text: String) {
        let scalars = Array(text.utf16)
        guard !scalars.isEmpty else { return }

        guard
            let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
            let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else {
            fputs("Failed to create unicode keyboard event.\n", stderr)
            return
        }

        keyDown.keyboardSetUnicodeString(stringLength: scalars.count, unicodeString: scalars)
        keyUp.keyboardSetUnicodeString(stringLength: scalars.count, unicodeString: scalars)
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }

    private static func keyTap(key: String, modifiers: [String]) {
        guard let keyCode = keyCode(for: key) else {
            fputs("Unknown key: \(key)\n", stderr)
            return
        }

        let modifierKeyCodes = modifiers.compactMap { modifierKeyCode(for: $0) }
        for modifier in modifierKeyCodes {
            postKey(modifier, keyDown: true)
        }

        postKey(keyCode, keyDown: true)
        postKey(keyCode, keyDown: false)

        for modifier in modifierKeyCodes.reversed() {
            postKey(modifier, keyDown: false)
        }
    }

    private static func postKey(_ keyCode: CGKeyCode, keyDown: Bool) {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: keyDown) else {
            fputs("Failed to create keyboard event.\n", stderr)
            return
        }

        event.post(tap: .cghidEventTap)
    }

    private static func setVolume(_ value: Double) {
        let percent = Int(max(0, min(100, round(value * 100))))
        runAppleScript("set volume output volume \(percent)")
    }

    private static func setMute(_ muted: Bool) {
        if muted {
            runAppleScript("set volume with output muted")
        } else {
            runAppleScript("set volume without output muted")
        }
    }

    private static func toggleMute() {
        runAppleScript("""
        set volumeState to get volume settings
        if output muted of volumeState then
          set volume without output muted
        else
          set volume with output muted
        end if
        """)
    }

    private static func runAppleScript(_ source: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", source]

        let stderrPipe = Pipe()
        process.standardError = stderrPipe

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            fputs("AppleScript failed to start: \(error.localizedDescription)\n", stderr)
            return
        }

        guard process.terminationStatus == 0 else {
            let errorData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            let errorText = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown AppleScript error"
            fputs("AppleScript failed: \(errorText)\n", stderr)
            return
        }
    }

    private static func emitStatusIfNeeded(force: Bool = false) {
        let trusted = AXIsProcessTrusted()
        guard force || lastAccessibilityStatus != trusted else {
            return
        }

        lastAccessibilityStatus = trusted

        if !trusted {
            fputs("Accessibility permissions are not granted. Input events may be ignored until Linka is allowed in System Settings > Privacy & Security > Accessibility.\n", stderr)
        }

        let warning = trusted
            ? ""
            : "Accessibility permissions are not granted. Allow Linka or Terminal in System Settings > Privacy & Security > Accessibility."
        let payload = """
        {"type":"status","nativeInputReady":\(trusted ? "true" : "false"),"inputWarning":\(jsonStringLiteral(warning))}
        """
        print(payload)
        fflush(stdout)
    }

    private static func jsonStringLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    private static func normalizedButton(_ button: String) -> String {
        button.lowercased() == "right" ? "right" : "left"
    }

    private static func keyCode(for key: String) -> CGKeyCode? {
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
        case "=": return 0x18
        case "9": return 0x19
        case "7": return 0x1A
        case "-": return 0x1B
        case "8": return 0x1C
        case "0": return 0x1D
        case "]": return 0x1E
        case "o": return 0x1F
        case "u": return 0x20
        case "[": return 0x21
        case "i": return 0x22
        case "p": return 0x23
        case "l": return 0x25
        case "j": return 0x26
        case "'": return 0x27
        case "k": return 0x28
        case ";": return 0x29
        case "\\": return 0x2A
        case ",": return 0x2B
        case "/": return 0x2C
        case "n": return 0x2D
        case "m": return 0x2E
        case ".": return 0x2F
        case "tab": return 0x30
        case "space": return 0x31
        case "enter", "return": return 0x24
        case "backspace", "delete": return 0x33
        case "escape", "esc": return 0x35
        default: return nil
        }
    }

    private static func modifierKeyCode(for modifier: String) -> CGKeyCode? {
        switch modifier.lowercased() {
        case "command", "cmd", "meta":
            return 0x37
        case "shift":
            return 0x38
        case "option", "alt":
            return 0x3A
        case "control", "ctrl":
            return 0x3B
        default:
            return nil
        }
    }

    private static func string(_ command: [String: Any], _ key: String) -> String? {
        command[key] as? String
    }

    private static func int(_ command: [String: Any], _ key: String) -> Int {
        if let value = command[key] as? Int {
            return value
        }
        if let value = command[key] as? Double {
            return Int(value.rounded())
        }
        return 0
    }

    private static func float(_ command: [String: Any], _ key: String) -> Double {
        if let value = command[key] as? Double {
            return value
        }
        if let value = command[key] as? Int {
            return Double(value)
        }
        return 0
    }

    private static func bool(_ command: [String: Any], _ key: String) -> Bool {
        command[key] as? Bool ?? false
    }

    private static func stringArray(_ command: [String: Any], _ key: String) -> [String] {
        command[key] as? [String] ?? []
    }
}

LinkaNativeInputMac.run()
