# Linka

Linka turns a phone browser into a local trackpad, keyboard, scroll pad, and volume controller for a Windows PC.

It exists for couch, TV, projector, and desk setups where reaching for a physical mouse or keyboard is inconvenient. The desktop app starts a local server, shows a QR code, and keeps the controller available from the Windows system tray.

## Features

- Phone-based trackpad with hold and right-click controls.
- Scroll, keyboard, volume, and mute controls.
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

Create a portable Windows executable:

```powershell
npm run build:win
```

Output:

```text
dist_electron\Linka.exe
```

## Project Structure

```text
.
|-- index.html                  # Mobile controller UI
|-- main.js                     # Electron main process and tray app
|-- server.js                   # Local HTTP/WebSocket server
|-- input-adapter.js            # Native input adapter selection
|-- native/win-input/           # .NET Windows input helper
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
