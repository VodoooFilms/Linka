# Linka

<img src="build/linka-logo.png" alt="Linka logo" width="160">

**Turn your phone into a local trackpad for your computer.**

Linka is a lightweight, open-source desktop app that lets you control your computer from your phone or tablet browser over your local network. Move the mouse, click, scroll, type, and transfer text, images, and small files — no cables, no cloud.

## Why Linka Exists

Controlling a desktop from a phone usually means installing a heavy remote-desktop client or sending data through a third-party server. Linka keeps everything on your local network:

- fast, low-latency input over WebSocket
- QR-based pairing — scan and go
- local-first: nothing leaves your LAN
- small packaged app that just does its job

## Current Capabilities

- Mouse move, drag, left/right click, and scroll from a phone browser
- Keyboard input with modifier shortcuts (Ctrl/Cmd/Alt/Option/Shift)
- Volume and mute control
- **Bridge**: transfer text, images, and small files between phone and computer, including screen capture
- Local pairing over the same network using QR-based session setup
- Tray or menu-bar presence to keep the app available

## How It Works

1. The desktop app starts a local server and shows a pairing QR code.
2. You scan the QR code with your phone and join the local session.
3. Your phone becomes a trackpad: touch moves and clicks the desktop cursor.
4. Bridge flows move local context such as text, screenshots, and small files.

## Platforms

| Platform | Desktop input | Packaging path | Notes |
| --- | --- | --- | --- |
| macOS | Yes | `npm run build:mac:app` / `npm run build:mac:dmg` | Native Swift helper; Accessibility permission required |
| Windows | Yes | `npm run build:win` / `npm run build:win:portable` | Uses C# native input |
| Linux | Yes on X11 | `npm run build:linux:dir` / `npm run build:linux:appimage` / `npm run build:linux:deb` | Uses bundled `xdotool`; Wayland input injection is not implemented |

Additional docs:

- [Architecture](ARCHITECTURE.md)
- [Linux validation report](docs/linka-linux-report-2026-06-09.md)

## Security And Local-First Principles

- Linka is designed for trusted local environments only
- Pairing and reconnect tokens are scoped to the current desktop session
- Local network access and platform permissions stay narrow and honest

Do not expose Linka to public or untrusted networks.

## Developing

```sh
npm install
npm run dev          # run the Electron app with a development server
npm run dev:server   # run only the local server (browser client)
npm test             # run the test suite
npm run lint         # typecheck
```

## Building

```sh
npm run build:mac:app   # build and install the app into /Applications (macOS)
npm run build:mac:dmg   # build a macOS DMG
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution areas and guidelines.

## License

MIT. See [LICENSE](LICENSE).