# Linka

<img src="build/linka-logo.png" alt="Linka logo" width="160">

**Approval-first local desktop runtime for AI agents.**

Linka is an open-source local desktop runtime that explores a missing layer in the current agent stack: safe, local, human-approved desktop execution. AI agents can reason, call APIs, and write code, but real work still happens on local machines, inside desktop applications, operating systems, and human workflows.

Today, Linka provides a cross-platform desktop foundation for local pairing, interaction, context transfer, and workflow teaching. The project is designed to evolve toward reusable agent workflows, human-in-the-loop execution, and future interoperability with MCP and Codex Skill-style workflows.

## Why Linka Exists

Modern AI agents are strongest when the environment is well structured: APIs, source code, tools, and documented workflows. Local desktop work is different. It often depends on application state, visible UI context, human judgment, and actions that should not run unattended.

Linka exists to explore that last-mile layer:

- local interaction instead of cloud relays
- explicit human approval instead of blind replay
- workflow teaching instead of hardcoded automation first
- reusable desktop context instead of one-off manual steps

This repository is not a general autonomous desktop agent. It is a local-first runtime foundation for building toward safer desktop agent workflows.

## Current Capabilities

- Cross-platform desktop foundation for macOS, Windows, and Linux
- Local-first pairing over the same network using QR-based session setup
- Mobile-to-desktop interaction layer for local input and control
- Desktop input backends for supported platforms
- Bridge flows for local text, image, and small file transfer
- Teach workflows on macOS for capturing reusable local workflow artifacts
- Session-scoped pairing and reconnect tokens
- Local tray or menu-bar presence for keeping the runtime available

Current features that may look like a remote-control utility are still part of the product, but they are not the main identity of the project. In Linka, they are part of the current local interaction layer that future agent workflows can build on.

## How It Works

1. A desktop app starts a local server and shows a pairing QR code.
2. A mobile browser joins the local session and becomes a local interaction surface.
3. Desktop input commands are routed through platform-specific backends.
4. Bridge flows move local context such as text, screenshots, and small files.
5. On macOS, Teach can capture a workflow and save a structured artifact for later human review.
6. The long-term goal is to turn these foundations into safe, reusable agent workflows with explicit approval boundaries.

## Platforms

Current project direction covers:

- macOS
- Windows
- Linux

Platform notes:

- macOS: strongest workflow-teaching support today
- Windows: native desktop input support and packaging flow
- Linux: cross-platform desktop direction is active, with desktop interaction depending on the platform path being used

Teach is not cross-platform today. It is currently a macOS-first workflow-teaching layer.

## Agent-Focused Use Cases

- Human-approved local desktop actions alongside coding or agent workflows
- Capturing repeatable desktop tasks for later review
- Moving local context between devices without introducing a cloud dependency
- Exploring how agents could safely act on local desktops instead of only through APIs
- Building future MCP-connected or reusable skill-based desktop workflows

## Current Status

What is implemented today:

- local desktop app runtime
- local pairing and session model
- local interaction surface via phone browser
- desktop input and control paths for supported platforms
- bridge and context-transfer flows
- macOS Teach workflow capture

What is not implemented yet:

- MCP-native server integration
- Codex Skill packaging or interoperability
- a general cross-platform approval engine
- cross-platform Teach support
- autonomous desktop execution without human review

## OpenAI Ecosystem Direction

Linka is being positioned to align with the parts of the OpenAI ecosystem that matter for local agent workflows:

- **MCP**: a future Linka MCP server could expose local desktop capabilities and context to models in a standard way
- **Codex Skills**: Linka Teach artifacts point toward reusable workflow bundles, but Codex Skills are not implemented here today
- **Human-in-the-loop workflows**: approval and review are core assumptions, especially for desktop actions
- **Local execution**: Linka is built around local state, local pairing, and local trust boundaries
- **Reusable agent workflows**: Teach is an early step toward workflows that can later become more structured and interoperable

Linka should be read as a foundation moving in this direction, not as a finished MCP or Codex integration.

## Project Pitch

Linka addresses a missing layer in the current agent stack: safe, local desktop action with human approval. The project already provides a cross-platform foundation for local interaction and workflow teaching. The next goal is to evolve Linka toward MCP-native integration, Codex Skill interoperability, and reusable human-approved desktop workflows.

## Roadmap

Phase 1 priorities are documentation, architecture clarity, and public positioning.

Near-term technical direction includes:

- MCP server design
- Codex Skill packaging research
- approval workflow modeling
- better cross-platform Teach support
- stronger packaging and release flows
- broader testing and platform validation

See [ROADMAP.md](ROADMAP.md) for the full roadmap.

## Security And Local-First Principles

- Linka is designed for trusted local environments
- Pairing and reconnect tokens are scoped to the current desktop session
- Desktop actions should be treated as human-reviewed operations
- Teach artifacts are descriptive and approval-oriented, not blind coordinate replay
- Local network access and platform permissions should remain narrow and honest

Do not expose Linka to public or untrusted networks.

## Contributing

Linka welcomes contributions from:

- agent builders
- desktop automation developers
- open-source contributors
- UX and interaction designers
- docs and example authors

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution areas and guidelines.

## License

MIT. See [LICENSE](LICENSE).
