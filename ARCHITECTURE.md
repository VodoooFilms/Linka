# Architecture

## Overview

Linka is a local-first desktop runtime that connects a desktop host, a mobile browser client, and platform-specific input layers. The current system is designed around explicit local trust boundaries and future human-approved agent workflows.

At a high level, Linka consists of:

- a mobile client
- a desktop app shell
- a local HTTP and WebSocket server
- a pairing and session model
- platform-specific input backends
- a bridge and context layer
- a workflow teaching layer

## Mobile Client

The mobile client runs in a phone browser and connects to the desktop host over the local network. Today, it acts as a local interaction surface for:

- session pairing
- input commands
- keyboard and pointer interaction
- bridge and context transfer flows
- Teach-related controls where available

This client is currently part of the local interaction layer. It is not presented as the long-term product identity, but it remains an important interface for local approval and input workflows.

## Desktop App

The desktop app is the local runtime host. It is responsible for:

- starting the local server
- showing pairing status and QR setup
- keeping the runtime available from the tray or menu bar
- coordinating local session state
- exposing platform capabilities such as capture and native input

The desktop app is where local trust begins. It is the machine that owns the permissions, local state, and execution boundary.

## Local Server

Linka uses a local HTTP and WebSocket server as the runtime coordination layer.

Responsibilities include:

- serving the local client
- establishing local pairing
- maintaining session state
- routing input commands
- managing bridge and context messages
- exposing local status and selected workflow endpoints

This server is currently a project-local runtime layer. It is not yet exposed as an MCP server.

## Pairing And Session Model

The pairing model is local-first and session-scoped.

Current behavior:

- the desktop host generates a local pairing URL
- a QR code lets a phone join the current session
- pairing and reconnect tokens are scoped to the active desktop session
- session reset invalidates prior pairing state

This model exists to keep local control bounded to the active desktop runtime instead of treating the system like a cloud account service.

## Native Input Layer

The input layer is platform-specific.

Current platform paths:

- macOS: native helper for desktop input and Teach-related capture
- Windows: native helper for desktop input
- Linux: platform path aimed at desktop interaction support, depending on the runtime environment used

The input layer is a current implementation detail that enables local interaction today. It is also the basis for any future agent-execution surface.

## Bridge And Context Layer

The bridge layer supports temporary local context exchange between the mobile client and the desktop host.

Examples:

- text transfer
- images
- small files
- screenshot-based context capture

This layer matters because useful desktop agent workflows need more than actions. They also need short-lived local context that a human can inspect and approve.

## Teach Workflow Layer

Teach is the most agent-relevant layer in the current repository.

Today, Teach is macOS-first and captures a workflow as a structured artifact intended for later review. The design direction is important:

- preserve intent
- keep app context
- capture a visual reference state
- avoid blind coordinate replay
- support human approval before future action

Teach is not the same thing as a finished reusable skill system. It is an early workflow-teaching layer.

## Trust Boundaries

Linka is built around explicit local trust boundaries.

Key assumptions:

- the desktop host is trusted by its operator
- the local network is treated as trusted or at least controlled
- desktop actions are sensitive and should not be treated as ordinary background automation
- platform permissions such as Accessibility or screen capture should be granted deliberately

This project should not be treated as a public remote access service.

## Human Approval Assumptions

Human approval is part of the intended architecture, even where the current implementation is still evolving.

Design assumptions:

- local desktop actions are high-impact
- recorded workflows should be reviewed, not replayed blindly
- future agent workflows should pause at meaningful approval boundaries
- the operator remains responsible for local execution decisions

This is why Linka is positioned as approval-first instead of autonomous-first.

## Implemented Today Vs Future Integration

Implemented today:

- local desktop app runtime
- local pairing and session model
- local interaction surface
- bridge and context flows
- platform input layers
- macOS-first Teach workflow capture

Not implemented today:

- MCP server support
- Codex Skill packaging or interoperability
- a standard approval protocol for agent orchestration
- reusable cross-platform skill execution layer

Future direction:

- expose Linka capabilities through MCP
- research how Teach artifacts could map to Codex Skill-style workflows
- formalize approval checkpoints for desktop action
- improve cross-platform workflow teaching and replay safety

## OpenAI Ecosystem Context

Linka is being shaped to align with:

- MCP as the standard interface for tools and context
- Codex Skills as reusable workflow bundles
- human-in-the-loop desktop action
- local execution for agents

That alignment is directional today. It is not a claim of full integration.
