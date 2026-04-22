# Linka

<img src="build/linka-logo.png" alt="Linka logo" width="160">

Linka turns a phone browser into a local remote controller and transfer bridge for a Windows PC.

It exists for couch, TV, projector, and desk setups where reaching for a physical mouse, keyboard, or quick transfer tool is inconvenient. The desktop app starts a local server, shows a QR code, and keeps the controller available from the Windows system tray.

Linka has two local modes:

- Remote mode: phone-based trackpad, keyboard, scroll, mouse, volume, and mute controls.
- Bridge mode: a temporary local space for sending text and images between phone and PC over the same WebSocket connection.

## Features

- Phone-based trackpad with hold and right-click controls.
- Scroll, keyboard, volume, and mute controls.
- Bridge mode for local text and image transfer between phone and PC.
- Ephemeral in-memory Bridge messages with no database, cloud sync, or permanent storage.
- Portrait and landscape mobile layouts.
- Local HTTP/WebSocket connection over your network.
- Portable Windows Electron build with a bundled native input helper.

## Requirements

- Windows for native mouse, keyboard, and volume control.
- Node.js 20 or newer.
- .NET 8 SDK for building the Windows native input helper.
- Phone and PC on the same local network.

## Quick Start

```powershell
npm install
npm run build:native:win
npm run dev:electron
```

Scan the QR code shown by the desktop window with your phone camera.

## Usage

- Use the phone screen as a trackpad.
- Use the scroll strip for vertical scrolling.
- Use Hold and Right for mouse actions.
- Use Keyboard to open mobile typing controls.
- Use Mute and Volume for Windows audio control.
- Use Bridge to switch into a clean transfer panel for sending text snippets and images between phone and PC.
- Use Copy on text items and Download on image items. Bridge data is RAM-only and disappears when the app/server restarts.

The local status endpoint is available at:

```text
http://localhost:3000/api/status
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

## Project Structure

```text
.
|-- index.html                  # Mobile remote and Bridge UI
|-- main.js                     # Electron main process and tray app
|-- server.js                   # Local HTTP/WebSocket server
|-- input-adapter.js            # Native input adapter selection
|-- native/win-input/           # .NET Windows input helper
|-- scripts/                    # Build helper scripts
|-- build/linka-icon.ico        # Windows app icon
|-- build/linka-logo.png        # Project logo asset
`-- linkalogo.png               # Legacy project logo asset
```

## Contributing

Issues and pull requests are welcome. Keep changes focused, describe what you tested, and avoid committing generated build output. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

If you find Linka useful, you can support its continued development with a voluntary contribution:

[PayPal](https://paypal.me/antoniomartinez75)

Contributions help maintain, improve, and keep the project evolving.

## License

Linka is released under the MIT License. See [LICENSE](LICENSE).
