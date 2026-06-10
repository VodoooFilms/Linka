# Linka Open Source Platform Notes

This repository now documents Linka as an open source desktop project with three platform targets:

- Windows
- macOS
- Linux

## Current status

| Platform | Status | Input backend | Packaging | Main caveats |
| --- | --- | --- | --- | --- |
| Windows | Mature | Native .NET helper | Installer and portable builds | Still the strongest release path |
| macOS | Functional | Native Swift helper | Local app bundle and DMG flow | Requires Accessibility and proper signing/notarization for distribution |
| Linux | Functional on X11 | Bundled `xdotool` + `libxdo` | Unpacked dir, AppImage, and `.deb` | No Wayland input injection yet |

## Repo layout intent

The repo is meant to keep all three desktop targets together:

- Shared UI, server, and Electron shell stay in the common codebase.
- Platform-specific input and packaging logic stay in their existing platform folders and scripts.
- Release work for one platform should not require removing or hiding the others.

## Release-facing summary

For GitHub readers, the project should now be understood as:

- A Windows desktop build with native input support.
- A macOS desktop build with native input support and Teach Mode.
- A Linux desktop build for X11 with bundled input dependencies.

## Build commands

Windows:

```powershell
npm run build:win
npm run build:win:portable
```

macOS:

```bash
npm run build:mac:app
npm run build:mac:dmg
```

Linux:

```bash
npm run build:linux:dir
npm run build:linux:appimage
npm run build:linux:deb
```

## Linux-specific note

The Linux path is open source and usable now, but it currently targets X11. Remote mouse and keyboard control rely on the bundled `xdotool` runtime. Wayland support remains future work.

## Related docs

- [Linux validation report](./linka-linux-report-2026-06-09.md)
- [Main README](../README.md)
