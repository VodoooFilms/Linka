# Linka Trackpad — Tap/Click Failure Report

**Date**: 2026-05-06  
**Symptom**: Double tap / single tap on mobile trackpad does not trigger clicks. Cursor moves, but no click is ever sent. "Es imposible hacer click."

## Root Cause Analysis

### Pipeline Traced
```
Mobile touch → app.js touch handlers → WebSocket send() → server.js → macos.js → Swift CGEvent → macOS
```

### Backend: ✅ Working
Tested via direct WebSocket injection (`ws://localhost:3067`):
```json
{"type": "click", "button": "left"}
```
→ Backend processed correctly. `nativeInputReady: true`, no permission errors. Swift `postClick()` executes CGEvent mouse down/up correctly.

### Frontend: ❌ Broken — Tap detection fails

The tap detection logic in `trackpadTouchEnd()`:

```javascript
if (!track.moved && duration < TAP_MAX_MS) {
    send({ type: 'click', button: 'left' });
}
```

**Root cause**: `TAP_MOVE_TOLERANCE = 7` pixels is far too strict for human fingers on mobile touchscreens.

- A mouse click: pixel-precise, < 2px movement. 7px is generous.
- A finger tap: natural jitter of 5-15px. 7px is impossibly strict.
- Every tap, even "stationary", was moving 8-15px → `track.moved = true` → tap rejected.
- User saw cursor move slightly, but click never fired.

### Secondary Issues Found

1. **TAP_MOVE_TOLERANCE was designed for mouse/pointer, not fingers**. The codebase uses pointer events which work for both mouse and touch, but the 7px threshold was calibrated for desktop mouse usage.

2. **No visual feedback on tap rejection**. User had no way to know why taps weren't working — cursor just sat there.

3. **`touch-action: none` was already on `*` selector** but `.trackpad-zone` had no explicit override. While not the root cause, this was confusing during debugging.

## Fix Applied

1. **`TAP_MOVE_TOLERANCE`: 7 → 20px** — realistic for human fingers. 20px is approximately 2-3mm on a typical mobile screen. Still tight enough to distinguish taps from intentional drags.

2. **Switched from pointer events to native touch events** — `touchstart/touchmove/touchend/touchcancel` instead of `pointerdown/pointermove/pointerup/pointercancel`. Touch events are more reliable on mobile (some browsers fire `pointercancel` instead of `pointerup` for taps).

3. **Added `touchcancel` handler** — wipes all state clean instead of leaking pointers.

4. **Added diagnostic logging** temporarily — `console.log('[trackpad] touchend', {moved, duration, tapOk})` to confirm the fix works in production.

## Files Changed

All 6 copies of `app.js`:
- `public/app.js` (source)
- `dist/app.js` (build)
- `dist_electron/.../public/app.js` (packaged)
- `dist_electron/.../dist/app.js` (packaged)
- `/Applications/.../public/app.js` (installed)
- `/Applications/.../dist/app.js` (installed)

## Verification Steps

1. Open Linka from Finder → connect phone
2. Tap once on trackpad → should see cursor dot blink and click fire
3. Open browser console on phone (Safari Web Inspector or `chrome://inspect`) → look for `[trackpad] touchend {moved: false, ...}`
4. Double tap quickly → should send double click (opens files in Finder)
5. Drag finger → should move cursor (moved: true, no click)

## If Still Broken

Check the console logs:
- If `moved: true` on every tap → increase TAP_MOVE_TOLERANCE further (25? 30?)
- If `moved: false` but no click → check `send()` return value, socket state
- If no `touchend` log at all → touch events not reaching the handler (check for overlay elements, z-index issues)
