# Linka

Linka turns a phone browser into a local trackpad, keyboard, scroll pad, and volume controller for a Windows PC or a Mac.

It exists for couch, TV, projector, and desk setups where reaching for a physical mouse or keyboard is inconvenient. The desktop app starts a local server, shows a QR code, and keeps the controller available from the system tray.

## Features

- Phone-based trackpad with hold and right-click controls.
- Scroll, keyboard, volume, and mute controls.
- Portrait and landscape mobile layouts.
- Local HTTP/WebSocket connection over your network.
- Works from Safari on iPhone and browsers on Android as long as the phone and desktop are on the same network.
- Native input helpers for Windows and macOS.

## Requirements

- Windows or macOS for native mouse, keyboard, and volume control.
- Node.js 20 or newer.
- .NET 8 SDK for building the Windows native input helper.
- Xcode Command Line Tools for building the macOS native input helper.
- Phone and PC on the same local network.

## Quick Start

Windows:

```powershell
npm install
npm run build:native:win
npm run dev:electron
```

macOS:

```bash
npm install
npm run build:native:mac
npm run dev:electron
```

Scan the QR code shown by the desktop window with your phone camera.

## Usage

- Use the phone screen as a trackpad.
- Use the scroll strip for vertical scrolling.
- Use Hold and Right for mouse actions.
- Use Keyboard to open mobile typing controls.
- Use Mute and Volume for desktop audio control.
- On macOS, grant Accessibility access to Linka or Terminal so mouse and keyboard events can be posted.
- If macOS permissions are missing, Linka still serves the controller UI but reports an input warning over `/api/status` and the initial WebSocket hello message.

The local status endpoint is available at:

```text
http://localhost:3000/api/status
```

Important fields include:

```json
{
  "hostPlatform": "darwin",
  "inputBackend": "mac-native",
  "nativeInputReady": false,
  "inputWarning": "Accessibility permissions are not granted. Allow Linka or Terminal in System Settings > Privacy & Security > Accessibility."
}
```

To use a different port:

```powershell
$env:LINKA_PORT=3001
npm run dev:electron
```

## Build

Create the Windows installer:

```powershell
npm run build:win
```

Output:

```text
dist_electron\Linka-Setup.exe
```

The installed app starts with Windows in the background, launches the local server, and stays available from the system tray. To create a portable executable instead, run `npm run build:win:portable`.

Create an unpacked macOS app bundle:

```bash
npm run build:mac:dir
```

This local macOS build path is intended for development and direct use on your own machine. Code signing, notarization, and polished distribution artifacts are intentionally out of scope in this pass.

## Project Structure

```text
.
|-- index.html                  # Mobile controller UI
|-- main.js                     # Electron main process and tray app
|-- server.js                   # Local HTTP/WebSocket server
|-- input-adapter.js            # Native input adapter selection
|-- native/win-input/           # .NET Windows input helper
|-- native/mac-input/           # Swift macOS input helper
|-- scripts/                    # Build helper scripts
|-- build/icon.ico              # Windows app icon
`-- linkalogo.png               # Project logo asset
```

## Contributing

Issues and pull requests are welcome. Keep changes focused, describe what you tested, and avoid committing generated build output. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

If you find Linka useful, you can support its continued development with a voluntary contribution:

[PayPal](https://paypal.me/antoniomartinez75)

Contributions help maintain, improve, and keep the project evolving.

## License

Linka is released under the MIT License. See [LICENSE](LICENSE).
