# Architecture

## Overview

Linka is a lightweight, local-first desktop runtime that connects a desktop host with a mobile browser client through platform-specific input layers. Everything stays on the local network.

At a high level, Linka consists of:

- a mobile client
- a desktop app shell
- a local HTTP and WebSocket server
- a pairing and session model
- platform-specific input backends
- a bridge and context layer

## Mobile Client

The mobile client runs in a phone browser and connects to the desktop host over the local network. It provides:

- session pairing (QR code)
- trackpad input: move, drag, click, scroll
- keyboard input with modifier shortcuts
- volume and mute controls
- bridge flows for text, images, and small files

The client is a single self-contained `index.html` (HTML, CSS, and JS inline) served by the desktop host.

## Desktop App

The desktop app is the local runtime host. It is responsible for:

- starting the local server
- showing pairing status and QR setup
- keeping the runtime available from the tray or menu bar
- coordinating local session state
- exposing platform capabilities such as native input

## Local Server

Linka uses a local HTTP and WebSocket server as the runtime coordination layer.

Responsibilities include:

- serving the local client
- establishing local pairing
- maintaining session state
- routing input commands
- managing bridge and context messages

## Pairing And Session Model

The pairing model is local-first and session-scoped.

Current behavior:

- the desktop host generates a local pairing URL
- a QR code lets a phone join the current session
- pairing and reconnect tokens are scoped to the active desktop session
- session reset invalidates prior pairing state

## Native Input Layer

The input layer is platform-specific.

- macOS: a compiled Swift helper (`native/mac-input/main.swift`) posts mouse, keyboard, scroll, and volume events
- Windows: a C# helper for desktop input
- Linux: bundled `xdotool` for X11 interaction

## Bridge And Context Layer

The bridge layer supports temporary local context exchange between the mobile client and the desktop host.

Examples:

- text transfer
- images
- small files
- screenshot-based context capture

## Trust Boundaries

Linka is built around explicit local trust boundaries.

Key assumptions:

- the desktop host is trusted by its operator
- the local network is treated as trusted or at least controlled
- platform permissions such as Accessibility should be granted deliberately

This project should not be treated as a public remote access service.

## Implemented Today

- local desktop app runtime
- local pairing and session model
- local interaction surface (trackpad, keyboard, volume)
- bridge and context flows
- platform input layers for macOS, Windows, and Linux